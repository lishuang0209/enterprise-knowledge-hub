from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .db import Chunk, Conversation, Document, KnowledgeBase, Message, ModelConfig, QueryLog, Setting, iso, loads, utcnow
from .parsers import Block, ParseError, chunk_blocks, extension_of, group_by_similarity, parse_file, semantic_sections
from .providers import ModelRow, ParseNeed, ProviderError, Usage, generate_with_langchain, rerank

NO_EVIDENCE = "在当前选中的知识库中，没有找到足以回答这个问题的依据。可以换一种问法，或让知识库管理人员补充资料。我不会用模型常识编造企业制度。"
EMPTY_METADATA = {"documentDate": "", "version": "", "subjects": [], "owners": [], "keywords": [], "questions": []}


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4()}"


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for piece in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(piece)
    return digest.hexdigest()


def size_label(amount: int) -> str:
    if amount < 1024 * 1024:
        return f"{max(1, round(amount / 1024))} KB"
    return f"{amount / 1024 / 1024:.1f} MB"


def normalize_metadata(value) -> dict:
    raw = value if isinstance(value, dict) else {}
    output = dict(EMPTY_METADATA)
    for key in ("documentDate", "version"):
        output[key] = str(raw.get(key) or "").strip()[:80]
    limits = {"subjects": 8, "owners": 8, "keywords": 16, "questions": 10}
    for key, limit in limits.items():
        items = raw.get(key) if isinstance(raw.get(key), list) else []
        cleaned = []
        for item in items:
            text = re.sub(r"\s+", " ", str(item or "")).strip(" ，,。；;：:")
            if text and text not in cleaned:
                cleaned.append(text[:120])
        output[key] = cleaned[:limit]
    return output


def extract_metadata_rules(name: str, content: str) -> dict:
    stem = re.sub(r"\.[^.]+$", "", name).strip()
    sample = content[:12000]
    date_matches = re.findall(r"(?<!\d)(20\d{2}[年./-](?:0?[1-9]|1[0-2])(?:[月./-](?:0?[1-9]|[12]\d|3[01])日?)?)(?!\d)", sample)
    version_matches = re.findall(r"(?:版本|版次|修订版|文件版本)\s*[:：]?\s*([A-Za-z]?\d+(?:\.\d+){0,3}|20\d{2}\s*版)", sample, re.I)
    if not version_matches:
        version_matches = re.findall(r"(?<!\w)(V\d+(?:\.\d+){0,3})(?!\w)", f"{name}\n{sample}", re.I)
    owner_matches = re.findall(r"(?:负责人|责任人|归口部门|负责部门|编制部门|发布部门)\s*[:：]\s*([^\n，,；;]{2,40})", sample)
    headings = []
    for line in sample.splitlines()[:80]:
        raw = line.strip()
        if not raw or raw.startswith("|"):
            continue
        text = re.sub(r"^\s*(?:#{1,6}\s+|[一二三四五六七八九十]+[、.]\s*|\d+[、.]\s*)", "", raw).strip()
        if text != raw and 2 <= len(text) <= 24 and not any(mark in text for mark in ("|", "：", ":", "。", "；")):
            headings.append(text)
    keywords = []
    for item in [stem, *headings]:
        if item and item not in keywords:
            keywords.append(item)
    return normalize_metadata({
        "documentDate": date_matches[0] if date_matches else "",
        "version": version_matches[0] if version_matches else "",
        "subjects": [stem] if stem else [],
        "owners": owner_matches,
        "keywords": keywords,
        "questions": [],
    })


def metadata_index_text(doc: Document) -> str:
    metadata = normalize_metadata(loads(doc.metadata_json, {}))
    parts = [
        f"文档时间：{metadata['documentDate']}" if metadata["documentDate"] else "",
        f"版本：{metadata['version']}" if metadata["version"] else "",
        f"主体：{'；'.join(metadata['subjects'])}" if metadata["subjects"] else "",
        f"负责人：{'；'.join(metadata['owners'])}" if metadata["owners"] else "",
        f"关键词：{'；'.join(metadata['keywords'])}" if metadata["keywords"] else "",
        f"可能的问题：{'；'.join(metadata['questions'])}" if metadata["questions"] else "",
    ]
    return "\n".join(part for part in parts if part)


def extract_document_metadata(db: Session, doc: Document) -> None:
    fallback = extract_metadata_rules(doc.name, doc.content)
    model = default_model(db, "LLM")
    if model is None:
        doc.metadata_json = json.dumps(fallback, ensure_ascii=False)
        doc.metadata_status = "fallback"
        doc.metadata_model = "本机规则"
        doc.metadata_error = "未配置已通过测试的对话模型，已使用本机规则抽取。"
        doc.metadata_updated_at = utcnow()
        return
    prompt = (
        "你负责企业文档元数据抽取。只根据文件名和正文返回一个 JSON 对象，不要输出解释或 Markdown。"
        "字段固定为 documentDate（发布日期/生效日期，未知为空字符串）、version（未知为空字符串）、"
        "subjects（主体、适用对象、组织或主要业务对象数组）、owners（负责人或负责部门数组）、"
        "keywords（便于检索的关键词数组，最多16个）、questions（用户可能检索的问题数组，最多10个）。"
        "不得猜测正文没有依据的日期、版本、人员或部门。"
    )
    sample = doc.content if len(doc.content) <= 12000 else f"{doc.content[:9000]}\n\n[中间内容省略]\n\n{doc.content[-2500:]}"
    try:
        pieces = []
        for token, _usage in generate_with_langchain(model, [{"role": "system", "content": prompt}, {"role": "user", "content": f"文件名：{doc.name}\n\n正文：\n{sample}"}]):
            if token:
                pieces.append(token)
        raw = "".join(pieces).strip()
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise ValueError("模型没有返回 JSON 对象")
        generated = normalize_metadata(json.loads(match.group(0)))
        merged = {}
        for key in EMPTY_METADATA:
            merged[key] = generated[key] if generated[key] else fallback[key]
        doc.metadata_json = json.dumps(normalize_metadata(merged), ensure_ascii=False)
        doc.metadata_status = "ready"
        doc.metadata_model = model.model
        doc.metadata_error = ""
    except Exception as exc:
        doc.metadata_json = json.dumps(fallback, ensure_ascii=False)
        doc.metadata_status = "fallback"
        doc.metadata_model = "本机规则"
        doc.metadata_error = f"模型抽取未完成，已使用本机规则：{str(exc)[:180]}"
    doc.metadata_updated_at = utcnow()


def get_role(db: Session) -> str:
    row = db.get(Setting, "role")
    return row.value if row and row.value in {"admin", "manager", "user"} else "admin"


def set_role(db: Session, role: str) -> None:
    row = db.get(Setting, "role")
    if row is None:
        db.add(Setting(key="role", value=role))
    else:
        row.value = role


def default_model(db: Session, kind: str) -> ModelRow | None:
    rows = db.scalars(select(ModelConfig).where(ModelConfig.kind == kind, ModelConfig.enabled.is_(True))).all()
    chosen = next((row for row in rows if row.is_default and row.status == "verified"), None)
    chosen = chosen or next((row for row in rows if row.status == "verified"), None)
    return ModelRow.from_orm(chosen) if chosen else None


def snapshot(db: Session) -> dict:
    bases = db.scalars(select(KnowledgeBase).options(selectinload(KnowledgeBase.documents).selectinload(Document.chunks))).all()
    models = db.scalars(select(ModelConfig)).all()
    conversations = db.scalars(select(Conversation).options(selectinload(Conversation.messages))).all()
    logs = db.scalars(select(QueryLog).order_by(QueryLog.at.desc()).limit(500)).all()
    documents = []
    for base in bases:
        for doc in base.documents:
            documents.append(document_dict(doc))
    return {
        "schemaVersion": 1,
        "role": get_role(db),
        "knowledgeBases": [kb_dict(item) for item in bases],
        "documents": documents,
        "models": [model_dict(item) for item in models],
        "conversations": [conversation_dict(item) for item in sorted(conversations, key=lambda row: row.updated_at, reverse=True)],
        "logs": [log_dict(item) for item in logs],
    }


def kb_dict(item: KnowledgeBase) -> dict:
    return {
        "id": item.id, "name": item.name, "description": item.description, "color": item.color,
        "category": item.category, "tags": loads(item.tags, []), "embeddingId": item.embedding_id,
        "rerankId": item.rerank_id, "chunkSize": item.chunk_size, "overlap": item.overlap,
        "chunkMode": item.chunk_mode or "length", "chunkSeparator": item.chunk_separator or "",
        "createdAt": iso(item.created_at), "updatedAt": iso(item.updated_at),
    }


def document_dict(item: Document) -> dict:
    segments = [{"index": chunk.position, "content": chunk.content, "location": chunk.location, "revised": chunk.revised} for chunk in item.chunks]
    metadata = normalize_metadata(loads(item.metadata_json, {}))
    return {
        "id": item.id, "kbId": item.kb_id, "name": item.name, "type": item.type, "size": item.size_label,
        "pages": item.pages, "chunks": len(segments), "status": item.status, "updatedAt": iso(item.updated_at),
        "error": item.error or None, "content": item.content, "sourceLabel": item.source_label,
        "segments": segments, "indexMode": item.index_mode,
        "metadata": metadata, "metadataStatus": item.metadata_status or "pending",
        "metadataModel": item.metadata_model or None, "metadataError": item.metadata_error or None,
        "metadataUpdatedAt": iso(item.metadata_updated_at) if item.metadata_updated_at else None,
    }


def model_dict(item: ModelConfig) -> dict:
    payload = {
        "id": item.id, "provider": item.provider, "kind": item.kind, "name": item.name, "model": item.model,
        "baseUrl": item.base_url, "enabled": item.enabled, "isDefault": item.is_default, "status": item.status,
        "hasCredential": bool(item.secret or item.access_key_id),
    }
    if item.kind == "Embedding":
        payload["dimensions"] = item.dimensions or None
    return payload


def conversation_dict(item: Conversation) -> dict:
    return {
        "id": item.id, "title": item.title, "kbIds": loads(item.kb_ids, []), "updatedAt": iso(item.updated_at),
        "messages": [message_dict(message) for message in item.messages],
    }


def message_dict(item: Message) -> dict:
    return {"id": item.id, "role": item.role, "content": item.content, "sources": loads(item.sources, []), "status": item.status}


def log_dict(item: QueryLog) -> dict:
    return {
        "id": item.id, "at": iso(item.at), "question": item.question, "kbIds": loads(item.kb_ids, []),
        "model": item.model, "status": item.status, "inputTokens": item.input_tokens, "outputTokens": item.output_tokens,
        "duration": item.duration, "firstToken": item.first_token, "stages": loads(item.stages, []),
        "answer": item.answer or None, "error": item.error or None,
    }


def split_document_blocks(db: Session, blocks: list[Block], *, size: int, overlap: int, mode: str = "length", separator: str = "") -> list[tuple[str, str]]:
    if mode == "qa":
        pairs = chunk_blocks(blocks, size, 0, mode="qa")
        if len(pairs) >= 2:
            return pairs
        paragraphs = chunk_blocks(blocks, max(size, 800), 0, mode="paragraph")[:6]
        return _qa_with_model(db, paragraphs or [(block.text, block.location) for block in blocks if block.text.strip()][:6])
    if mode == "semantic":
        return _semantic_with_model(db, blocks, size, overlap)
    return chunk_blocks(blocks, size, overlap, mode=mode, separator=separator)


def _semantic_with_model(db: Session, blocks: list[Block], size: int, overlap: int) -> list[tuple[str, str]]:
    from .providers import embed_texts

    model = default_model(db, "Embedding")
    if model is None:
        raise ParseError("语义拆分需要已启用并通过连接测试的向量模型。")
    sections = semantic_sections(blocks)
    units = [unit for section in sections for unit in section]
    if not units:
        return []
    vectors: list[list[float]] = []
    for start in range(0, len(units), 10):
        batch = [text[:500] for text, _location in units[start:start + 10]]
        embedded, _usage = embed_texts(model, batch)
        vectors.extend(embedded)
    output: list[tuple[str, str]] = []
    offset = 0
    for section in sections:
        count = len(section)
        output.extend(group_by_similarity(section, vectors[offset:offset + count], size, overlap))
        offset += count
    return output


def _qa_with_model(db: Session, paragraphs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    model = default_model(db, "LLM")
    if model is None:
        raise ParseError("问答拆分需要已启用并通过连接测试的对话模型。文中如果已有「问：」「答：」，会直接拆开，不必调用模型。")
    prompt = "下面是一段资料。请整理成问答。答案尽量保留原文，不要编造资料里没有的内容。每个问答单独成段，格式固定为「问：」和「答：」。最多 5 个问答。"
    output: list[tuple[str, str]] = []
    for text, location in paragraphs:
        collected: list[str] = []
        for token, _usage in generate_with_langchain(model, [{"role": "system", "content": prompt}, {"role": "user", "content": text[:1800]}]):
            if token:
                collected.append(token)
        pairs = chunk_blocks([Block("".join(collected), location)], 4000, 0, mode="qa")
        output.extend(pairs or [(text, location)])
    if not output:
        raise ParseError("问答拆分没有得到可索引的内容。")
    return output


def store_parsed_document(db: Session, kb: KnowledgeBase, *, name: str, path, raw_size: int, digest: str, prefer_cloud: bool = False) -> Document:
    ext = extension_of(name)
    doc = Document(
        id=new_id("doc"), kb_id=kb.id, name=name, type=ext.upper(), size_label=size_label(raw_size),
        status="review", sha256=digest, path=str(path), updated_at=utcnow(), created_at=utcnow(),
    )
    try:
        blocks, pages = fill_blocks(db, kb, path, name, prefer_cloud=prefer_cloud)
        pieces = split_document_blocks(db, blocks, size=kb.chunk_size, overlap=kb.overlap, mode=kb.chunk_mode or "length", separator=kb.chunk_separator or "")
        if not pieces:
            raise ParseError("没有产生可索引的文本。")
        doc.pages = pages
        doc.content = "\n\n".join(text for text, _location in pieces)
        doc.source_label = pieces[0][1]
        doc.chunks = [Chunk(id=new_id("chunk"), position=index, content=text, location=location) for index, (text, location) in enumerate(pieces)]
        extract_document_metadata(db, doc)
    except (ParseError, ParseNeed, ProviderError) as exc:
        doc.status = "failed"
        doc.error = str(exc)
    db.add(doc)
    kb.updated_at = utcnow()
    return doc


def refresh_review_document(db: Session, kb: KnowledgeBase, doc: Document, path, name: str, prefer_cloud: bool = False) -> Document:
    try:
        blocks, pages = fill_blocks(db, kb, path, name, prefer_cloud=prefer_cloud)
        pieces = split_document_blocks(db, blocks, size=kb.chunk_size, overlap=kb.overlap, mode=kb.chunk_mode or "length", separator=kb.chunk_separator or "")
        if not pieces:
            raise ParseError("没有产生可索引的文本。")
        for chunk in list(doc.chunks):
            db.delete(chunk)
        db.flush()
        doc.pages = pages
        doc.content = "\n\n".join(text for text, _location in pieces)
        doc.source_label = pieces[0][1]
        doc.chunks = [Chunk(id=new_id("chunk"), document_id=doc.id, position=index, content=text, location=location) for index, (text, location) in enumerate(pieces)]
        if doc.metadata_status != "edited":
            extract_document_metadata(db, doc)
        doc.status = "review"
        doc.error = ""
    except (ParseError, ParseNeed, ProviderError) as exc:
        doc.status = "failed"
        doc.error = str(exc)
    doc.updated_at = utcnow()
    kb.updated_at = utcnow()
    return doc


def fill_blocks(db: Session, kb: KnowledgeBase, path, name: str, prefer_cloud: bool = False) -> tuple[list[Block], int]:
    ext = extension_of(name)
    needs_cloud = prefer_cloud or ext in {"png", "jpg", "jpeg", "webp", "doc"}
    if needs_cloud and prefer_cloud and ext not in {"png", "jpg", "jpeg", "webp", "doc", "pdf"}:
        needs_cloud = ext in {"png", "jpg", "jpeg", "webp", "doc"}
    if not needs_cloud:
        try:
            return parse_file(path, name)
        except ParseError as exc:
            if ext != "pdf":
                raise
            cloud = _ocr_blocks(db, path, name)
            if cloud:
                return cloud
            raise exc
    cloud = _ocr_blocks(db, path, name)
    if not cloud:
        if prefer_cloud:
            raise ParseNeed("已选择云端解析，但 DocMind 未启用或未通过测试。")
        raise ParseNeed("图片或旧版 Word 需要已启用并通过测试的 DocMind。")
    return cloud


def _ocr_blocks(db: Session, path, name: str) -> tuple[list[Block], int] | None:
    model = default_model(db, "OCR")
    if model is None:
        return None
    from .providers import parse_with_docmind

    pairs = parse_with_docmind(model, path, name)
    pages = []
    blocks = []
    for text, location in pairs:
        match = re.search(r"第\s*(\d+)\s*页", location)
        page = int(match.group(1)) if match else 1
        pages.append(page)
        blocks.append(Block(text, location, page=page))
    return blocks, max(pages or [1])


def apply_embeddings(db: Session, doc: Document, *, clear_without_model: bool = True) -> str | None:
    kb = db.get(KnowledgeBase, doc.kb_id)
    embedder = None
    if kb and kb.embedding_id:
        row = db.get(ModelConfig, kb.embedding_id)
        if row and row.enabled and row.status == "verified" and row.kind == "Embedding":
            embedder = ModelRow.from_orm(row)
    if embedder is None:
        embedder = default_model(db, "Embedding")
    if embedder is None:
        if clear_without_model:
            for chunk in doc.chunks:
                chunk.embedding = ""
                chunk.embedding_model = ""
            doc.index_mode = "关键词"
        elif any(chunk.embedding for chunk in doc.chunks):
            model_name = next((chunk.embedding_model for chunk in doc.chunks if chunk.embedding_model), "")
            doc.index_mode = f"元数据关键词 + {model_name}" if model_name else "关键词"
        else:
            doc.index_mode = "关键词"
        return None
    from .providers import embed_texts

    metadata_text = metadata_index_text(doc)
    texts = [f"{metadata_text}\n\n正文片段：\n{chunk.content}" if metadata_text else chunk.content for chunk in doc.chunks]
    try:
        vectors, _usage = embed_texts(embedder, texts) if texts else ([], Usage())
    except ProviderError as exc:
        return exc.message
    for chunk, vector in zip(doc.chunks, vectors):
        chunk.embedding = json.dumps(vector)
        chunk.embedding_model = embedder.model
    doc.index_mode = f"元数据关键词 + {embedder.model}"
    return None


def build_document(db: Session, doc: Document) -> None:
    doc.status = "indexing"
    doc.error = ""
    doc.updated_at = utcnow()
    db.commit()
    if doc.metadata_status in {"pending", "failed", ""}:
        extract_document_metadata(db, doc)
    error = apply_embeddings(db, doc)
    if error:
        doc.status = "failed"
        doc.error = f"向量化失败：{error}"
        doc.updated_at = utcnow()
        db.commit()
        return
    doc.status = "ready"
    doc.updated_at = utcnow()
    kb = db.get(KnowledgeBase, doc.kb_id)
    if kb:
        kb.updated_at = utcnow()
    db.commit()


def refresh_indexed_metadata(db: Session, doc: Document) -> None:
    if doc.status != "ready" or doc.metadata_status not in {"pending", ""}:
        return
    try:
        extract_document_metadata(db, doc)
        error = apply_embeddings(db, doc, clear_without_model=False)
        if error:
            extra = f"向量索引未刷新：{error}"
            doc.metadata_error = f"{doc.metadata_error} {extra}".strip() if doc.metadata_error else extra
    except Exception as exc:
        fallback = extract_metadata_rules(doc.name, doc.content or "")
        doc.metadata_json = json.dumps(fallback, ensure_ascii=False)
        doc.metadata_status = "fallback"
        doc.metadata_model = "本机规则"
        doc.metadata_error = f"自动抽取未完成，已使用本机规则：{str(exc)[:180]}"
        doc.metadata_updated_at = utcnow()
    doc.status = "ready"
    doc.updated_at = utcnow()
    kb = db.get(KnowledgeBase, doc.kb_id)
    if kb:
        kb.updated_at = utcnow()
    db.commit()


@dataclass
class Hit:
    chunk: Chunk
    document: Document
    score: float
    method: str


def retrieve(db: Session, kb_ids: list[str], question: str, limit: int = 5) -> tuple[list[Hit], str, list[dict]]:
    started = time.perf_counter()
    rows = db.scalars(
        select(Chunk).join(Document).where(Document.kb_id.in_(kb_ids), Document.status == "ready").options(selectinload(Chunk.document))
    ).all()
    if not rows:
        return [], "没有已就绪资料", []
    terms = query_terms(question)
    def searchable(chunk: Chunk) -> str:
        return f"{chunk.content}\n{chunk.document.name}\n{metadata_index_text(chunk.document)}"

    keyword_ranked = sorted(rows, key=lambda chunk: keyword_score(searchable(chunk), terms), reverse=True)
    keyword_ranked = [chunk for chunk in keyword_ranked if keyword_score(searchable(chunk), terms) > 0][:20]
    stages = [{"label": "关键词检索", "ms": int((time.perf_counter() - started) * 1000)}]
    vector_ranked: list[Chunk] = []
    note = "当前使用关键词检索。"
    embedder = default_model(db, "Embedding")
    bound_ids = {db.get(KnowledgeBase, kb_id).embedding_id for kb_id in kb_ids if db.get(KnowledgeBase, kb_id)}
    bound_ids.discard("")
    if len(bound_ids) > 1:
        note = "所选知识库绑定了不同向量模型，本次按库分别检索后合并。"
    if embedder is not None:
        vector_start = time.perf_counter()
        try:
            from .providers import embed_texts

            vectors, _usage = embed_texts(embedder, [question])
            query_vector = vectors[0]
            scored = []
            for chunk in rows:
                if not chunk.embedding or chunk.embedding_model != embedder.model:
                    continue
                scored.append((cosine(query_vector, json.loads(chunk.embedding)), chunk))
            vector_ranked = [chunk for _score, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:20]]
            stages.append({"label": "向量检索", "ms": int((time.perf_counter() - vector_start) * 1000)})
            note = f"关键词与 {embedder.model} 向量召回后融合。"
        except ProviderError as exc:
            stages.append({"label": "向量检索失败", "ms": int((time.perf_counter() - vector_start) * 1000)})
            note = f"向量检索失败（{exc.message}），已回退到关键词结果。"
    fused = rrf([ranking for ranking in (keyword_ranked, vector_ranked) if ranking])[: max(limit, 8)]
    method = "融合" if vector_ranked else "关键词"
    reranker = default_model(db, "Rerank")
    if reranker and fused:
        rerank_start = time.perf_counter()
        try:
            order, _usage = rerank(reranker, question, [f"{metadata_index_text(chunk.document)}\n\n{chunk.content}" for chunk in fused])
            fused = [fused[index] for index, _score in order]
            method = "重排"
            stages.append({"label": "重排", "ms": int((time.perf_counter() - rerank_start) * 1000)})
            note += " 已使用云端重排。"
        except ProviderError as exc:
            stages.append({"label": "重排失败", "ms": int((time.perf_counter() - rerank_start) * 1000)})
            note += f" 重排失败（{exc.message}），已保留融合顺序。"
            method = "融合·重排降级"
    hits = []
    for chunk in fused[:limit]:
        lexical = keyword_score(searchable(chunk), terms)
        display = min(0.99, 0.35 + lexical / 12) if method.startswith("融合") or method == "关键词" else min(0.99, 0.55 + lexical / 20)
        hits.append(Hit(chunk=chunk, document=chunk.document, score=round(display, 2), method=method))
    if not hits and keyword_ranked:
        hits = [Hit(chunk=chunk, document=chunk.document, score=0.4, method="关键词") for chunk in keyword_ranked[:limit]]
    return hits, note, stages


def query_terms(question: str) -> list[str]:
    compact = re.sub(r"\s+", "", question.lower())
    compact = re.sub(r"请问|告诉我|介绍一下|有哪些|是什么|怎么样|怎么|如何|能否|是否|什么|相关|关于|需要|可以|以及|应该|我们|公司|企业|知识库|吗|呢|的", "", compact)
    terms = set(re.findall(r"[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", compact))
    expanded = set(terms)
    for term in list(terms):
        if re.fullmatch(r"[\u4e00-\u9fff]+", term):
            for index in range(len(term) - 1):
                expanded.add(term[index:index + 2])
    return [term for term in expanded if len(term) >= 2]


def keyword_score(text: str, terms: list[str]) -> int:
    haystack = text.lower()
    return sum(min(len(term), 4) for term in terms if term in haystack)


def cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return -1
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if not left_norm or not right_norm:
        return -1
    return dot / (left_norm * right_norm)


def rrf(rankings: list[list[Chunk]], k: int = 60) -> list[Chunk]:
    scores: dict[str, float] = {}
    lookup: dict[str, Chunk] = {}
    for ranking in rankings:
        for index, chunk in enumerate(ranking):
            lookup[chunk.id] = chunk
            scores[chunk.id] = scores.get(chunk.id, 0) + 1 / (k + index + 1)
    return [lookup[key] for key, _score in sorted(scores.items(), key=lambda item: item[1], reverse=True)]


def source_payload(hit: Hit) -> dict:
    location = hit.chunk.location
    if hit.chunk.revised:
        location = f"{location} · 人工修订"
    return {
        "id": hit.chunk.id, "docId": hit.document.id, "kbId": hit.document.kb_id,
        "title": hit.document.name, "location": location, "content": hit.chunk.content,
        "snapshotUpdatedAt": iso(hit.document.updated_at),
    }


def evidence_prompt(question: str, hits: list[Hit], history: list[dict]) -> list[dict]:
    lines = []
    for index, hit in enumerate(hits, start=1):
        lines.append(f"[{index}] {hit.document.name} · {hit.chunk.location}\n{hit.chunk.content}")
    history_text = "\n".join(f"{item['role']}: {item['content']}" for item in history[-6:])
    system = (
        "你是企业知识库助手。只根据给定资料回答，资料不足时明确说明没有找到依据，不要用常识补充企业制度。"
        "回答使用简体中文，并在依据后标注资料编号，例如 [1]。不要编造不存在的来源。"
    )
    user = f"历史对话：\n{history_text or '无'}\n\n资料：\n" + "\n\n".join(lines) + f"\n\n问题：{question}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def extractive_answer(hits: list[Hit]) -> str:
    if not hits:
        return NO_EVIDENCE
    parts = ["未配置可用的对话模型，以下是检索到的依据摘录，不是模型生成的回答。"]
    for index, hit in enumerate(hits, start=1):
        parts.append(f"[{index}] {hit.document.name} · {hit.chunk.location}\n{hit.chunk.content[:700]}")
    return "\n\n".join(parts)
