from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from .config import DB_PATH, ensure_dirs

ensure_dirs()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(16), default="blue")
    category: Mapped[str] = mapped_column(String(40), default="通用知识")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    embedding_id: Mapped[str] = mapped_column(String(64), default="")
    rerank_id: Mapped[str] = mapped_column(String(64), default="")
    chunk_size: Mapped[int] = mapped_column(Integer, default=800)
    overlap: Mapped[int] = mapped_column(Integer, default=80)
    chunk_mode: Mapped[str] = mapped_column(String(16), default="length")
    chunk_separator: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    documents: Mapped[list[Document]] = relationship(back_populates="knowledge_base", cascade="all, delete-orphan")


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kb_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(240))
    type: Mapped[str] = mapped_column(String(16))
    size_label: Mapped[str] = mapped_column(String(32), default="")
    pages: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="review")
    error: Mapped[str] = mapped_column(Text, default="")
    source_label: Mapped[str] = mapped_column(String(240), default="")
    content: Mapped[str] = mapped_column(Text, default="")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    path: Mapped[str] = mapped_column(Text, default="")
    index_mode: Mapped[str] = mapped_column(String(32), default="")
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    metadata_status: Mapped[str] = mapped_column(String(16), default="pending")
    metadata_model: Mapped[str] = mapped_column(String(180), default="")
    metadata_error: Mapped[str] = mapped_column(Text, default="")
    metadata_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    knowledge_base: Mapped[KnowledgeBase] = relationship(back_populates="documents")
    chunks: Mapped[list[Chunk]] = relationship(back_populates="document", cascade="all, delete-orphan", order_by="Chunk.position")


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    location: Mapped[str] = mapped_column(String(240), default="")
    revised: Mapped[bool] = mapped_column(Boolean, default=False)
    embedding: Mapped[str] = mapped_column(Text, default="")
    embedding_model: Mapped[str] = mapped_column(String(160), default="")
    document: Mapped[Document] = relationship(back_populates="chunks")


class ModelConfig(Base):
    __tablename__ = "model_configs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(80))
    model: Mapped[str] = mapped_column(String(180))
    base_url: Mapped[str] = mapped_column(String(300))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    dimensions: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="untested")
    secret: Mapped[str] = mapped_column(Text, default="")
    access_key_id: Mapped[str] = mapped_column(Text, default="")


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(80))
    kb_ids: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    messages: Mapped[list[Message]] = relationship(back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at")


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="complete")
    sources: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class QueryLog(Base):
    __tablename__ = "query_logs"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    question: Mapped[str] = mapped_column(Text)
    kb_ids: Mapped[str] = mapped_column(Text, default="[]")
    model: Mapped[str] = mapped_column(String(180), default="")
    status: Mapped[str] = mapped_column(String(16))
    input_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration: Mapped[int] = mapped_column(Integer, default=0)
    first_token: Mapped[int] = mapped_column(Integer, default=0)
    stages: Mapped[str] = mapped_column(Text, default="[]")
    answer: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")


engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _connection_record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    ensure_dirs()
    Base.metadata.create_all(engine)
    _ensure_kb_chunk_columns()
    _ensure_document_metadata_columns()
    with SessionLocal() as db:
        if db.get(Setting, "role") is None:
            db.add(Setting(key="role", value="admin"))
            db.commit()
        if db.query(ModelConfig).count() == 0:
            db.add_all(_preset_models())
            db.commit()


def _ensure_kb_chunk_columns() -> None:
    with engine.begin() as conn:
        names = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(knowledge_bases)").fetchall()}
        if "chunk_mode" not in names:
            conn.exec_driver_sql("ALTER TABLE knowledge_bases ADD COLUMN chunk_mode VARCHAR(16) DEFAULT 'length'")
        if "chunk_separator" not in names:
            conn.exec_driver_sql("ALTER TABLE knowledge_bases ADD COLUMN chunk_separator VARCHAR(80) DEFAULT ''")


def _ensure_document_metadata_columns() -> None:
    columns = {
        "metadata_json": "TEXT DEFAULT '{}'",
        "metadata_status": "VARCHAR(16) DEFAULT 'pending'",
        "metadata_model": "VARCHAR(180) DEFAULT ''",
        "metadata_error": "TEXT DEFAULT ''",
        "metadata_updated_at": "DATETIME",
    }
    with engine.begin() as conn:
        names = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(documents)").fetchall()}
        for name, definition in columns.items():
            if name not in names:
                conn.exec_driver_sql(f"ALTER TABLE documents ADD COLUMN {name} {definition}")


def _preset_models() -> list[ModelConfig]:
    rows = [
        ("llm-tongyi", "通义", "LLM", "通义 · 对话模型", "qwen-plus", "https://dashscope.aliyuncs.com/compatible-mode/v1", 0),
        ("embed-tongyi", "通义", "Embedding", "通义 · 文本向量", "text-embedding-v4", "https://dashscope.aliyuncs.com/compatible-mode/v1", 1024),
        ("rerank-tongyi", "通义", "Rerank", "通义 · 检索重排", "qwen3-rerank", "https://dashscope.aliyuncs.com/compatible-api/v1/reranks", 0),
        ("llm-openrouter", "OpenRouter", "LLM", "OpenRouter · 对话模型", "openai/gpt-4.1-mini", "https://openrouter.ai/api/v1", 0),
        ("embed-openrouter", "OpenRouter", "Embedding", "OpenRouter · 文本向量", "openai/text-embedding-3-small", "https://openrouter.ai/api/v1", 1536),
        ("rerank-openrouter", "OpenRouter", "Rerank", "OpenRouter · 检索重排", "cohere/rerank-v3.5", "https://openrouter.ai/api/v1", 0),
        ("llm-aihubmix", "AIHubmix", "LLM", "AIHubmix · 对话模型", "gpt-4.1-mini", "https://aihubmix.com/v1", 0),
        ("embed-aihubmix", "AIHubmix", "Embedding", "AIHubmix · 文本向量", "text-embedding-3-small", "https://aihubmix.com/v1", 1536),
        ("rerank-aihubmix", "AIHubmix", "Rerank", "AIHubmix · 检索重排", "jina-reranker-v3", "https://aihubmix.com/v1", 0),
        ("ocr-docmind", "DocMind", "OCR", "阿里云 DocMind · 文档解析", "文档解析（大模型版）", "https://docmind-api.cn-hangzhou.aliyuncs.com", 0),
    ]
    return [
        ModelConfig(id=i, provider=p, kind=k, name=n, model=m, base_url=u, enabled=False, is_default=False, dimensions=d, status="untested")
        for i, p, k, n, m, u, d in rows
    ]


def iso(value: datetime | None) -> str:
    if value is None:
        return utcnow().isoformat()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def loads(raw: str, fallback):
    try:
        return json.loads(raw or "")
    except json.JSONDecodeError:
        return fallback
