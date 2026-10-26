from __future__ import annotations

import asyncio
import json
import queue
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .config import ALLOWED, FILES, IMAGE_TYPES, MAX_BATCH, MAX_FILE_BYTES, MAX_IMAGE_BYTES, ROLES
from .db import Chunk, Conversation, Document, KnowledgeBase, Message, ModelConfig, QueryLog, SessionLocal, init_db, utcnow
from .parsers import ParseError, extension_of
from .pipeline import (
    NO_EVIDENCE,
    build_document,
    default_model,
    evidence_prompt,
    extractive_answer,
    fill_blocks,
    get_role,
    message_dict,
    new_id,
    normalize_metadata,
    retrieve,
    set_role,
    sha256_file,
    snapshot,
    source_payload,
    refresh_review_document,
    split_document_blocks,
    store_parsed_document,
)
from .providers import ModelRow, ParseNeed, ProviderError, test_model
from .secrets import encrypt

_stop = threading.Event()
_worker: Optional[threading.Thread] = None


def session() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def current_role(db: Session = Depends(session), x_role: Optional[str] = Header(default=None)) -> str:
    if x_role in ROLES:
        return x_role
    return get_role(db)


def require_manager(role: str = Depends(current_role)) -> str:
    if role == "user":
        raise HTTPException(403, "当前角色只能使用在线问答。")
    return role


def require_admin(role: str = Depends(current_role)) -> str:
    if role != "admin":
        raise HTTPException(403, "此操作仅管理员可用。")
    return role


def recover_interrupted_jobs() -> None:
    with SessionLocal() as db:
        stuck = db.scalars(select(Document).where(Document.status == "indexing")).all()
        for doc in stuck:
            doc.status = "queued"
            doc.updated_at = utcnow()
        if stuck:
            db.commit()


def worker_loop() -> None:
    while not _stop.is_set():
        doc_id = None
        with SessionLocal() as db:
            doc = db.scalar(select(Document).where(Document.status == "queued").limit(1))
            if doc is not None:
                doc.status = "indexing"
                doc.updated_at = utcnow()
                db.commit()
                doc_id = doc.id
        if not doc_id:
            _stop.wait(0.4)
            continue
        with SessionLocal() as db:
            current = db.scalar(select(Document).where(Document.id == doc_id).options(selectinload(Document.chunks)))
            if current is None:
                continue
            try:
                build_document(db, current)
            except Exception as exc:
                current.status = "failed"
                current.error = str(exc)[:500]
                current.updated_at = utcnow()
                db.commit()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _worker
    init_db()
    recover_interrupted_jobs()
    _stop.clear()
    _worker = threading.Thread(target=worker_loop, name="zhixu-jobs", daemon=True)
    _worker.start()
    yield
    _stop.set()


app = FastAPI(title="知序企业知识库", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class RoleIn(BaseModel):
    role: str


class KnowledgeIn(BaseModel):
    name: str = Field(max_length=40)
    description: str = ""
    category: str = "通用知识"
    tags: list[str] = []
    embeddingId: str = ""
    rerankId: str = ""
    chunkSize: int = 800
    overlap: int = 80
    chunkMode: str = "length"
    chunkSeparator: str = ""
    color: str = ""


class BuildIn(BaseModel):
    ids: list[str]


class RechunkIn(BaseModel):
    chunkSize: int = 800
    overlap: int = 80
    chunkMode: str = "length"
    chunkSeparator: str = ""
    save: bool = False


class DeleteDocsIn(BaseModel):
    ids: list[str]


class SnippetIn(BaseModel):
    content: str


class MetadataIn(BaseModel):
    documentDate: str = ""
    version: str = ""
    subjects: list[str] = Field(default_factory=list)
    owners: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)


class RetrieveIn(BaseModel):
    question: str
    limit: int = 5


class ModelIn(BaseModel):
    name: str
    provider: str
    kind: str
    model: str
    baseUrl: str
    enabled: bool = True
    isDefault: bool = False
    dimensions: Optional[int] = None
    apiKey: str = ""
    accessKeyId: str = ""


class ShareModelIn(BaseModel):
    kind: str
    model: str
    dimensions: Optional[int] = None


class ShareKeyIn(BaseModel):
    provider: str
    apiKey: str = ""
    models: list[ShareModelIn] = []


class ToggleIn(BaseModel):
    enabled: bool
    replacementId: Optional[str] = None


class ChatIn(BaseModel):
    question: str
    kbIds: list[str]
    conversationId: Optional[str] = None
    replaceMessageId: Optional[str] = None


class ConversationIn(BaseModel):
    kbIds: list[str]


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/state")
def state(role: str = Depends(current_role), db: Session = Depends(session)) -> dict:
    set_role(db, role)
    db.commit()
    payload = snapshot(db)
    payload["role"] = role
    return payload


@app.put("/api/role")
def update_role(body: RoleIn, db: Session = Depends(session)) -> dict:
    if body.role not in ROLES:
        raise HTTPException(400, "无效角色。")
    set_role(db, body.role)
    db.commit()
    payload = snapshot(db)
    payload["role"] = body.role
    return payload


@app.post("/api/knowledge-bases")
def create_kb(body: KnowledgeIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "请填写知识库名称。")
    if db.scalar(select(KnowledgeBase).where(KnowledgeBase.name == name)):
        raise HTTPException(409, "已存在同名知识库。")
    _validate_chunk(body.chunkSize, body.overlap)
    colors = ["blue", "violet", "teal"]
    count = db.query(KnowledgeBase).count()
    kb = KnowledgeBase(
        id=new_id("kb"), name=name, description=body.description.strip(), color=body.color or colors[count % 3],
        category=body.category, tags=json.dumps(body.tags[:5], ensure_ascii=False), embedding_id=body.embeddingId,
        rerank_id=body.rerankId, chunk_size=body.chunkSize, overlap=body.overlap,
        chunk_mode=_chunk_mode(body.chunkMode), chunk_separator=_chunk_separator(body.chunkMode, body.chunkSeparator),
    )
    db.add(kb)
    db.commit()
    return snapshot(db)


@app.patch("/api/knowledge-bases/{kb_id}")
def update_kb(kb_id: str, body: KnowledgeIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    kb = db.get(KnowledgeBase, kb_id)
    if kb is None:
        raise HTTPException(404, "知识库不存在。")
    name = body.name.strip()
    other = db.scalar(select(KnowledgeBase).where(KnowledgeBase.name == name, KnowledgeBase.id != kb_id))
    if other:
        raise HTTPException(409, "已存在同名知识库。")
    _validate_chunk(body.chunkSize, body.overlap)
    kb.name, kb.description, kb.category = name, body.description.strip(), body.category
    kb.tags = json.dumps(body.tags[:5], ensure_ascii=False)
    kb.embedding_id, kb.rerank_id = body.embeddingId, body.rerankId
    kb.chunk_size, kb.overlap = body.chunkSize, body.overlap
    kb.chunk_mode, kb.chunk_separator = _chunk_mode(body.chunkMode), _chunk_separator(body.chunkMode, body.chunkSeparator)
    kb.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.delete("/api/knowledge-bases/{kb_id}")
def delete_kb(kb_id: str, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    kb = db.scalar(select(KnowledgeBase).where(KnowledgeBase.id == kb_id).options(selectinload(KnowledgeBase.documents)))
    if kb is None:
        raise HTTPException(404, "知识库不存在。")
    for doc in kb.documents:
        _unlink(doc.path)
    db.delete(kb)
    db.commit()
    return snapshot(db)


@app.post("/api/documents/preview")
async def preview_documents(
    kbId: str = Form(),
    chunkSize: int = Form(800),
    overlap: int = Form(80),
    chunkMode: str = Form("length"),
    chunkSeparator: str = Form(""),
    parseMode: str = Form("auto"),
    files: list[UploadFile] = File(),
    _role: str = Depends(require_manager),
    db: Session = Depends(session),
) -> dict:
    kb = db.get(KnowledgeBase, kbId)
    if kb is None:
        raise HTTPException(404, "知识库不存在。")
    if len(files) > MAX_BATCH:
        raise HTTPException(400, "单次最多导入 20 份文件。")
    _validate_chunk(chunkSize, overlap)
    kb.chunk_size, kb.overlap = chunkSize, overlap
    kb.chunk_mode, kb.chunk_separator = _chunk_mode(chunkMode), _chunk_separator(chunkMode, chunkSeparator)
    created = []
    for upload in files:
        name = Path(upload.filename or "未命名").name
        ext = extension_of(name)
        if ext not in ALLOWED:
            created.append({"name": name, "status": "failed", "error": "暂不支持该文件格式。", "chunks": []})
            continue
        data = await upload.read()
        limit = MAX_IMAGE_BYTES if ext in IMAGE_TYPES else MAX_FILE_BYTES
        if len(data) > limit:
            created.append({"name": name, "status": "failed", "error": f"文件超过 {limit // (1024 * 1024)} MB。", "chunks": []})
            continue
        target = FILES / f"{new_id('file')}-{name}"
        target.write_bytes(data)
        digest = sha256_file(target)
        existing = db.scalar(select(Document).where(Document.kb_id == kb.id, Document.sha256 == digest, Document.status != "failed").options(selectinload(Document.chunks)))
        if existing and existing.status != "review":
            target.unlink(missing_ok=True)
            created.append({"name": name, "status": "failed", "error": f"知识库中已有相同文件：{existing.name}", "chunks": []})
            continue
        if existing:
            source = Path(existing.path)
            if source.exists():
                target.unlink(missing_ok=True)
            else:
                existing.path = str(target)
                source = target
            doc = refresh_review_document(db, kb, existing, source, name, prefer_cloud=parseMode == "ocr")
        else:
            doc = store_parsed_document(db, kb, name=name, path=target, raw_size=len(data), digest=digest, prefer_cloud=parseMode == "ocr")
        db.commit()
        db.refresh(doc)
        created.append({
            "id": doc.id, "name": doc.name, "status": doc.status, "error": doc.error or None,
            "chunks": [{"content": chunk.content, "location": chunk.location} for chunk in doc.chunks],
            "metadata": normalize_metadata(json.loads(doc.metadata_json or "{}")), "metadataStatus": doc.metadata_status,
        })
    return {"documents": created, "state": snapshot(db)}


@app.post("/api/documents/build")
def build_documents(body: BuildIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    docs = db.scalars(select(Document).where(Document.id.in_(body.ids))).all()
    if not docs:
        raise HTTPException(404, "没有找到待构建的文档。")
    for doc in docs:
        if doc.status == "failed" and not doc.chunks:
            continue
        doc.status = "queued"
        doc.error = ""
        doc.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.post("/api/documents/{doc_id}/retry")
def retry_document(doc_id: str, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    doc = db.scalar(select(Document).where(Document.id == doc_id).options(selectinload(Document.chunks)))
    if doc is None:
        raise HTTPException(404, "文档不存在。")
    kb = db.get(KnowledgeBase, doc.kb_id)
    path = Path(doc.path)
    if kb is None or not path.exists():
        raise HTTPException(400, "原文件已不在本地，请重新导入。")
    try:
        blocks, pages = fill_blocks(db, kb, path, doc.name)
        pieces = split_document_blocks(db, blocks, size=kb.chunk_size, overlap=kb.overlap, mode=kb.chunk_mode or "length", separator=kb.chunk_separator or "")
        if not pieces:
            raise ParseError("没有产生可索引的文本。")
    except (ParseError, ProviderError) as exc:
        doc.status = "failed"
        doc.error = str(exc)
        doc.updated_at = utcnow()
        db.commit()
        return snapshot(db)
    for chunk in list(doc.chunks):
        db.delete(chunk)
    db.flush()
    doc.chunks = [Chunk(id=new_id("chunk"), document_id=doc.id, position=index, content=text, location=location) for index, (text, location) in enumerate(pieces)]
    doc.pages = pages
    doc.content = "\n\n".join(text for text, _location in pieces)
    doc.source_label = pieces[0][1]
    doc.metadata_status = "pending" if doc.metadata_status != "edited" else "edited"
    doc.status = "queued"
    doc.error = ""
    doc.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.post("/api/documents/{doc_id}/rechunk")
def rechunk_document(doc_id: str, body: RechunkIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    _validate_chunk(body.chunkSize, body.overlap)
    doc = db.scalar(select(Document).where(Document.id == doc_id).options(selectinload(Document.chunks)))
    if doc is None:
        raise HTTPException(404, "文档不存在。")
    if doc.status == "indexing":
        raise HTTPException(409, "文档正在构建，请稍后再修改分段。")
    kb = db.get(KnowledgeBase, doc.kb_id)
    path = Path(doc.path)
    if kb is None or not path.exists():
        raise HTTPException(400, "原文件已不在本地，请重新导入。")
    try:
        blocks, pages = fill_blocks(db, kb, path, doc.name)
        pieces = split_document_blocks(db, blocks, size=body.chunkSize, overlap=body.overlap, mode=_chunk_mode(body.chunkMode), separator=_chunk_separator(body.chunkMode, body.chunkSeparator))
        if not pieces:
            raise ParseError("没有产生可索引的文本。")
    except (ParseError, ParseNeed, ProviderError) as exc:
        raise HTTPException(400, str(exc)) from exc
    chunks = [{"content": text, "location": location} for text, location in pieces]
    if not body.save:
        return {"chunks": chunks, "state": snapshot(db)}
    for chunk in list(doc.chunks):
        db.delete(chunk)
    db.flush()
    doc.chunks = [Chunk(id=new_id("chunk"), document_id=doc.id, position=index, content=text, location=location) for index, (text, location) in enumerate(pieces)]
    doc.pages = pages
    doc.content = "\n\n".join(text for text, _location in pieces)
    doc.source_label = pieces[0][1]
    if doc.metadata_status != "edited":
        doc.metadata_status = "pending"
    doc.status = "queued"
    doc.error = ""
    doc.updated_at = utcnow()
    kb.chunk_size, kb.overlap = body.chunkSize, body.overlap
    kb.chunk_mode, kb.chunk_separator = _chunk_mode(body.chunkMode), _chunk_separator(body.chunkMode, body.chunkSeparator)
    kb.updated_at = utcnow()
    db.commit()
    return {"chunks": chunks, "state": snapshot(db)}


@app.post("/api/documents/delete")
def delete_documents(body: DeleteDocsIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    docs = db.scalars(select(Document).where(Document.id.in_(body.ids))).all()
    for doc in docs:
        _unlink(doc.path)
        db.delete(doc)
    db.commit()
    return snapshot(db)


@app.patch("/api/documents/{doc_id}/chunks/{position}")
def edit_chunk(doc_id: str, position: int, body: SnippetIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    doc = db.scalar(select(Document).where(Document.id == doc_id).options(selectinload(Document.chunks)))
    if doc is None:
        raise HTTPException(404, "文档不存在。")
    chunk = next((item for item in doc.chunks if item.position == position), None)
    if chunk is None:
        raise HTTPException(404, "片段不存在。")
    text = body.content.strip()
    if not text:
        raise HTTPException(400, "片段内容不能为空。")
    chunk.content = text
    chunk.revised = True
    chunk.embedding = ""
    doc.content = "\n\n".join(item.content for item in doc.chunks)
    if doc.metadata_status != "edited":
        doc.metadata_status = "pending"
    doc.status = "queued"
    doc.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.patch("/api/documents/{doc_id}/metadata")
def update_document_metadata(doc_id: str, body: MetadataIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    doc = db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在。")
    doc.metadata_json = json.dumps(normalize_metadata(body.model_dump()), ensure_ascii=False)
    doc.metadata_status = "edited"
    doc.metadata_model = "人工修订"
    doc.metadata_error = ""
    doc.metadata_updated_at = utcnow()
    if doc.chunks and doc.status != "review":
        doc.status = "queued"
        doc.error = ""
    doc.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.post("/api/documents/{doc_id}/metadata/extract")
def reextract_document_metadata(doc_id: str, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    doc = db.get(Document, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在。")
    if not doc.chunks:
        raise HTTPException(400, "文档尚未解析出可索引内容。")
    doc.metadata_status = "pending"
    doc.metadata_model = ""
    doc.metadata_error = ""
    doc.status = "queued"
    doc.error = ""
    doc.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.post("/api/knowledge-bases/{kb_id}/retrieve")
def retrieve_kb(kb_id: str, body: RetrieveIn, _role: str = Depends(require_manager), db: Session = Depends(session)) -> dict:
    if db.get(KnowledgeBase, kb_id) is None:
        raise HTTPException(404, "知识库不存在。")
    hits, note, stages = retrieve(db, [kb_id], body.question.strip(), max(1, min(body.limit, 10)))
    return {
        "note": note,
        "stages": stages,
        "hits": [{**source_payload(hit), "score": hit.score, "method": hit.method, "index": hit.chunk.position} for hit in hits],
    }


@app.post("/api/models/share-key")
def share_provider_key(body: ShareKeyIn, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    provider = body.provider.strip()
    if provider not in {"通义", "OpenRouter", "AIHubmix"}:
        raise HTTPException(400, "请选择通义、OpenRouter 或 AIHubmix。文档解析仍单独填写 AccessKey。")
    secret = body.apiKey.strip()
    if len(secret) < 8:
        raise HTTPException(400, "请填写 API Key。")
    rows = list(db.scalars(select(ModelConfig).where(ModelConfig.provider == provider, ModelConfig.kind != "OCR")).all())
    chosen = {item.kind: item for item in body.models}
    if any(kind not in {"LLM", "Embedding", "Rerank"} for kind in chosen):
        raise HTTPException(400, "只能选择对话、向量或重排模型。")
    labels = {"LLM": "对话模型", "Embedding": "文本向量", "Rerank": "检索重排"}
    by_kind = {row.kind: row for row in rows}
    targets = []
    for kind in ("LLM", "Embedding", "Rerank"):
        row = by_kind.get(kind)
        picked = chosen.get(kind)
        if row is None and picked is None:
            continue
        if row is None and picked is not None:
            row = ModelConfig(
                id=new_id("model"), provider=provider, kind=kind, name=f"{provider} · {labels[kind]}",
                model=picked.model.strip() or "未填写", base_url=_provider_base_url(provider, kind),
                enabled=False, is_default=False, dimensions=0, status="untested",
            )
            db.add(row)
        if row is not None:
            targets.append(row)
    if not targets:
        raise HTTPException(404, "没有找到该供应商的服务。")
    for row in targets:
        picked = chosen.get(row.kind)
        if picked is not None:
            model_id = picked.model.strip()
            if not model_id or len(model_id) > 160:
                raise HTTPException(400, "请填写模型 ID。")
            dimensions = picked.dimensions or row.dimensions or 0
            changed = model_id != row.model or (row.kind == "Embedding" and dimensions != (row.dimensions or 0))
            if changed and _model_in_use(db, row):
                raise HTTPException(409, "这项模型已被知识库使用。请先解除绑定，或保持原来的模型 ID。")
            row.model = model_id
            if row.kind == "Embedding":
                if dimensions < 1:
                    raise HTTPException(400, "请填写向量维度。")
                row.dimensions = dimensions
        row.secret = encrypt(secret)
        row.status = "untested"
        row.enabled = True
        for item in db.scalars(select(ModelConfig).where(ModelConfig.kind == row.kind)).all():
            item.is_default = item.id == row.id
    db.commit()
    return snapshot(db)


@app.post("/api/models")
def create_model(body: ModelIn, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    _check_model(body)
    if db.scalar(select(ModelConfig).where(ModelConfig.name == body.name.strip())):
        raise HTTPException(409, "此服务名称已存在。")
    row = ModelConfig(id=new_id("model"), status="untested")
    _apply_model(db, row, body)
    db.add(row)
    db.commit()
    return snapshot(db)


@app.patch("/api/models/{model_id}")
def update_model(model_id: str, body: ModelIn, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    row = db.get(ModelConfig, model_id)
    if row is None:
        raise HTTPException(404, "模型配置不存在。")
    _check_model(body)
    other = db.scalar(select(ModelConfig).where(ModelConfig.name == body.name.strip(), ModelConfig.id != model_id))
    if other:
        raise HTTPException(409, "此服务名称已存在。")
    changed = any([
        body.model.strip() != row.model, body.baseUrl.strip() != row.base_url, body.provider != row.provider,
        body.kind != row.kind, (body.dimensions or 0) != (row.dimensions or 0), bool(body.apiKey or body.accessKeyId),
    ])
    _apply_model(db, row, body, reset_status=changed)
    db.commit()
    return snapshot(db)


@app.post("/api/models/{model_id}/toggle")
def toggle_model(model_id: str, body: ToggleIn, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    row = db.get(ModelConfig, model_id)
    if row is None:
        raise HTTPException(404, "模型配置不存在。")
    if not body.enabled and _model_in_use(db, row):
        raise HTTPException(409, "该配置仍被知识库引用，请先更换绑定。")
    row.enabled = body.enabled
    if not body.enabled:
        row.is_default = False
        if body.replacementId:
            replacement = db.get(ModelConfig, body.replacementId)
            if replacement and replacement.kind == row.kind and replacement.enabled:
                for item in db.scalars(select(ModelConfig).where(ModelConfig.kind == row.kind)).all():
                    item.is_default = item.id == replacement.id
    db.commit()
    return snapshot(db)


@app.post("/api/models/{model_id}/default")
def default_model_route(model_id: str, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    row = db.get(ModelConfig, model_id)
    if row is None or not row.enabled:
        raise HTTPException(400, "请先启用此服务。")
    for item in db.scalars(select(ModelConfig).where(ModelConfig.kind == row.kind)).all():
        item.is_default = item.id == row.id
    db.commit()
    return snapshot(db)


@app.delete("/api/models/{model_id}")
def delete_model(model_id: str, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    row = db.get(ModelConfig, model_id)
    if row is None:
        raise HTTPException(404, "模型配置不存在。")
    if row.is_default or _model_in_use(db, row):
        raise HTTPException(409, "请先取消默认设置并解除知识库引用。")
    db.delete(row)
    db.commit()
    return snapshot(db)


@app.post("/api/models/{model_id}/test")
def run_model_test(model_id: str, _role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    row = db.get(ModelConfig, model_id)
    if row is None:
        raise HTTPException(404, "模型配置不存在。")
    if not row.enabled:
        raise HTTPException(400, "请先启用服务，再测试连接。")
    result = test_model(ModelRow.from_orm(row))
    row.status = "verified" if result["ok"] else "failed"
    if result.get("dimensions") and row.kind == "Embedding" and not row.dimensions:
        row.dimensions = int(result["dimensions"])
    db.commit()
    return {"result": result, "state": snapshot(db)}


@app.patch("/api/conversations/{conversation_id}")
def patch_conversation(conversation_id: str, body: ConversationIn, db: Session = Depends(session)) -> dict:
    row = db.get(Conversation, conversation_id)
    if row is None:
        raise HTTPException(404, "会话不存在。")
    row.kb_ids = json.dumps(body.kbIds)
    row.updated_at = utcnow()
    db.commit()
    return snapshot(db)


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db: Session = Depends(session)) -> dict:
    row = db.get(Conversation, conversation_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return snapshot(db)


@app.post("/api/chat/stream")
async def chat_stream(body: ChatIn, request: Request, db: Session = Depends(session)):
    question = body.question.strip()
    if not question or len(question) > 2000:
        raise HTTPException(400, "问题需要在 1 到 2000 字之间。")
    kb_ids = [kb_id for kb_id in body.kbIds if db.get(KnowledgeBase, kb_id)]
    if not kb_ids:
        raise HTTPException(400, "请选择知识库。")
    conversation = db.get(Conversation, body.conversationId) if body.conversationId else None
    if conversation is None:
        conversation = Conversation(id=new_id("conversation"), title=question[:20] + ("…" if len(question) > 20 else ""), kb_ids=json.dumps(kb_ids))
        db.add(conversation)
        db.flush()
    conversation.kb_ids = json.dumps(kb_ids)
    history = [{"role": item.role, "content": item.content} for item in conversation.messages if item.role == "user" or item.status == "complete"]
    if body.replaceMessageId:
        assistant = db.get(Message, body.replaceMessageId)
        if assistant is None:
            raise HTTPException(404, "要重试的回答不存在。")
        assistant.content = ""
        assistant.status = "streaming"
        assistant.sources = "[]"
    else:
        db.add(Message(id=new_id("message"), conversation_id=conversation.id, role="user", content=question, status="complete"))
        assistant = Message(id=new_id("message"), conversation_id=conversation.id, role="assistant", content="", status="streaming", sources="[]")
        db.add(assistant)
    conversation.updated_at = utcnow()
    db.commit()
    conversation_id = conversation.id
    assistant_id = assistant.id
    llm = default_model(db, "LLM")

    async def events():
        started = time_ms()
        first_token = 0
        pieces: list[str] = []
        usage_in = None
        usage_out = None
        status = "success"
        error = ""
        model_name = llm.model if llm else "未配置对话模型"
        with SessionLocal() as read_db:
            hits, note, stages = retrieve(read_db, kb_ids, question, 4)
            sources = [source_payload(hit) for hit in hits]
            prompt_messages = evidence_prompt(question, hits, history) if hits else []
            excerpt = extractive_answer(hits) if hits else NO_EVIDENCE
        yield _sse("meta", {"conversationId": conversation_id, "messageId": assistant_id, "sources": sources})
        try:
            if not sources:
                text = NO_EVIDENCE
                pieces.append(text)
                first_token = time_ms() - started
                yield _sse("token", {"text": text})
            elif llm is None:
                text = excerpt
                status = "degraded"
                error = "未配置已通过测试的对话模型，本次返回检索摘录。"
                model_name = "检索摘录"
                for index in range(0, len(text), 24):
                    if await request.is_disconnected():
                        status = "cancelled"
                        error = "生成已停止，未获取最终用量。"
                        break
                    piece = text[index:index + 24]
                    if not first_token:
                        first_token = time_ms() - started
                    pieces.append(piece)
                    yield _sse("token", {"text": piece})
                    await asyncio.sleep(0.02)
            else:
                messages = prompt_messages
                channel: queue.Queue = queue.Queue()

                def produce() -> None:
                    try:
                        for text, usage in generate_with_langchain(llm, messages):
                            channel.put(("data", text, usage))
                        channel.put(("end", "", None))
                    except ProviderError as exc:
                        channel.put(("error", exc.message, exc.kind))

                threading.Thread(target=produce, daemon=True).start()
                while True:
                    if await request.is_disconnected():
                        status = "cancelled"
                        error = "生成已停止，未获取最终用量。"
                        break
                    kind, text, extra = await asyncio.to_thread(channel.get)
                    if kind == "end":
                        break
                    if kind == "error":
                        status = "failed"
                        error = text
                        if "重排降级" in note:
                            status = "degraded"
                        break
                    if extra is not None:
                        usage_in, usage_out = extra.input_tokens, extra.output_tokens
                    if text:
                        if not first_token:
                            first_token = time_ms() - started
                        pieces.append(text)
                        yield _sse("token", {"text": text})
                if "重排降级" in note and status == "success":
                    status = "degraded"
                    error = note
        except Exception as exc:
            status = "failed"
            error = str(exc)[:300]
        answer = "".join(pieces)
        if status == "cancelled":
            usage_in = usage_out = None
        duration = time_ms() - started
        with SessionLocal() as write_db:
            message = write_db.get(Message, assistant_id)
            conversation_row = write_db.get(Conversation, conversation_id)
            if message is not None:
                message.content = answer
                message.status = "cancelled" if status == "cancelled" else "complete"
                message.sources = json.dumps(sources, ensure_ascii=False)
            if conversation_row is not None:
                conversation_row.updated_at = utcnow()
            log = QueryLog(
                id=new_id("log"), question=question, kb_ids=json.dumps(kb_ids), model=model_name, status=status,
                input_tokens=usage_in, output_tokens=usage_out, duration=duration, first_token=first_token,
                stages=json.dumps(stages, ensure_ascii=False), answer=answer, error=error,
            )
            write_db.add(log)
            write_db.commit()
            payload = {"message": message_dict(message) if message else None, "logId": log.id, "status": status, "error": error}
        yield _sse("done", payload)

    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/api/admin/reset")
def reset_workspace(_role: str = Depends(require_admin), db: Session = Depends(session)) -> dict:
    for doc in db.scalars(select(Document)).all():
        _unlink(doc.path)
    for model in db.scalars(select(ModelConfig)).all():
        db.delete(model)
    for table in (QueryLog, Message, Conversation, Document, KnowledgeBase):
        db.query(table).delete()
    db.commit()
    init_db()
    return snapshot(db)


def _validate_chunk(size: int, overlap: int) -> None:
    if not 200 <= size <= 4000 or overlap < 0 or overlap >= size:
        raise HTTPException(400, "重叠长度需要小于分块长度。")


def _chunk_mode(mode: str) -> str:
    chosen = (mode or "length").strip()
    if chosen not in {"length", "paragraph", "separator", "qa", "semantic"}:
        raise HTTPException(400, "请选择分块方式。")
    return chosen


def _chunk_separator(mode: str, separator: str) -> str:
    value = (separator or "")[:80]
    if _chunk_mode(mode) == "separator" and not value.strip():
        raise HTTPException(400, "请填写自定义分隔符。")
    return value


def _check_model(body: ModelIn) -> None:
    if (body.kind == "OCR") != (body.provider == "DocMind"):
        raise HTTPException(400, "DocMind 只用于文档解析。")
    if not body.baseUrl.startswith("https://"):
        raise HTTPException(400, "服务地址需要使用 HTTPS。")
    if body.kind == "Embedding" and not body.dimensions:
        raise HTTPException(400, "请填写向量维度。")


def _provider_base_url(provider: str, kind: str) -> str:
    if provider == "通义":
        return "https://dashscope.aliyuncs.com/compatible-api/v1/reranks" if kind == "Rerank" else "https://dashscope.aliyuncs.com/compatible-mode/v1"
    if provider == "OpenRouter":
        return "https://openrouter.ai/api/v1"
    return "https://aihubmix.com/v1"


def _apply_model(db: Session, row: ModelConfig, body: ModelIn, reset_status: bool = True) -> None:
    row.provider, row.kind = body.provider, body.kind
    row.name, row.model, row.base_url = body.name.strip(), body.model.strip(), body.baseUrl.strip()
    row.enabled, row.dimensions = body.enabled, body.dimensions or 0
    if body.apiKey:
        row.secret = encrypt(body.apiKey.strip())
    if body.accessKeyId:
        row.access_key_id = encrypt(body.accessKeyId.strip())
    if reset_status:
        row.status = "untested"
    if body.isDefault and body.enabled:
        for item in db.scalars(select(ModelConfig).where(ModelConfig.kind == body.kind)).all():
            item.is_default = False
        row.is_default = True
    else:
        row.is_default = False


def _model_in_use(db: Session, row: ModelConfig) -> bool:
    if row.kind == "Embedding":
        return db.scalar(select(KnowledgeBase).where(KnowledgeBase.embedding_id == row.id)) is not None
    if row.kind == "Rerank":
        return db.scalar(select(KnowledgeBase).where(KnowledgeBase.rerank_id == row.id)) is not None
    return False


def _unlink(path: str) -> None:
    if path:
        Path(path).unlink(missing_ok=True)


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def time_ms() -> int:
    return int(__import__("time").perf_counter() * 1000)
