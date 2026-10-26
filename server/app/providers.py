from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Iterator
from urllib.parse import urlparse

import httpx

from .secrets import decrypt


class ProviderError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class ModelRow:
    id: str
    provider: str
    kind: str
    name: str
    model: str
    base_url: str
    enabled: bool
    is_default: bool
    dimensions: int
    status: str
    secret: str = ""
    access_key_id: str = ""
    has_credential: bool = False

    @classmethod
    def from_orm(cls, row) -> "ModelRow":
        secret = decrypt(row.secret) if row.secret else ""
        access = decrypt(row.access_key_id) if row.access_key_id else ""
        return cls(
            id=row.id, provider=row.provider, kind=row.kind, name=row.name, model=row.model,
            base_url=row.base_url, enabled=row.enabled, is_default=row.is_default,
            dimensions=row.dimensions or 0, status=row.status, secret=secret, access_key_id=access,
            has_credential=bool(secret or access),
        )


@dataclass
class Generation:
    text: str = ""
    usage: Usage = field(default_factory=Usage)


def _root(base_url: str) -> str:
    return base_url.rstrip("/")


def _classify(response: httpx.Response) -> ProviderError | None:
    if response.status_code in {401, 403}:
        return ProviderError("auth", "服务拒绝了凭证，请核对 API Key、业务空间或 AccessKey。")
    if response.status_code == 429:
        return ProviderError("rate", "供应商限流，请稍后重试。")
    if response.status_code >= 500:
        return ProviderError("unavailable", f"供应商服务暂不可用（HTTP {response.status_code}）。")
    if response.status_code >= 400:
        detail = response.text[:240]
        return ProviderError("format", f"请求被拒绝：{detail or response.status_code}")
    return None


def _request(method: str, url: str, *, key: str, payload: dict | None = None, timeout: float = 40) -> dict:
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        response = httpx.request(method, url, headers=headers, json=payload, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise ProviderError("timeout", "请求未在预期时间内完成。") from exc
    except httpx.HTTPError as exc:
        raise ProviderError("unavailable", f"无法连接服务：{exc}") from exc
    error = _classify(response)
    if error:
        raise error
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderError("format", "供应商返回的不是 JSON。") from exc
    if not isinstance(body, dict):
        raise ProviderError("format", "供应商返回格式无法识别。")
    return body


def _usage_from(body: dict) -> Usage:
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion = usage.get("completion_tokens", usage.get("output_tokens"))
    if prompt is None and completion is None and usage.get("total_tokens") is None:
        return Usage()
    return Usage(
        input_tokens=prompt if isinstance(prompt, int) else None,
        output_tokens=completion if isinstance(completion, int) else None,
    )


def embed_texts(model: ModelRow, texts: list[str]) -> tuple[list[list[float]], Usage]:
    if not model.secret:
        raise ProviderError("auth", "尚未保存向量模型凭证。")
    url = _root(model.base_url)
    if not url.endswith("/embeddings"):
        url = f"{url}/embeddings"
    payload: dict = {"model": model.model, "input": texts}
    if model.dimensions:
        payload["dimensions"] = model.dimensions
    body = _request("POST", url, key=model.secret, payload=payload, timeout=60)
    vectors = _read_embeddings(body)
    if len(vectors) != len(texts):
        raise ProviderError("format", "向量条数与输入不一致。")
    width = len(vectors[0]) if vectors else 0
    if model.dimensions and width != model.dimensions:
        raise ProviderError("format", f"返回维度 {width} 与配置的 {model.dimensions} 不一致，已阻止写入，不会截断向量。")
    if any(len(item) != width for item in vectors):
        raise ProviderError("format", "同一批向量维度不一致。")
    return vectors, _usage_from(body)


def _read_embeddings(body: dict) -> list[list[float]]:
    data = body.get("data")
    if isinstance(data, list):
        ordered = sorted(data, key=lambda item: item.get("index", 0))
        vectors = [item.get("embedding") for item in ordered if isinstance(item, dict)]
        if vectors and all(_is_vector(item) for item in vectors):
            return vectors
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    embeddings = output.get("embeddings")
    if isinstance(embeddings, list):
        vectors = []
        for item in embeddings:
            if isinstance(item, dict) and _is_vector(item.get("embedding")):
                vectors.append(item["embedding"])
        if vectors:
            return vectors
    raise ProviderError("format", "响应中没有可用的向量数组。")


def _is_vector(value) -> bool:
    return isinstance(value, list) and bool(value) and all(isinstance(number, (int, float)) for number in value)


def rerank(model: ModelRow, query: str, documents: list[str]) -> tuple[list[tuple[int, float]], Usage]:
    if not model.secret:
        raise ProviderError("auth", "尚未保存重排模型凭证。")
    url = _root(model.base_url)
    native = "text-rerank" in url
    if not native and not url.endswith("/rerank") and not url.endswith("/reranks"):
        url = f"{url}/rerank"
    if native:
        payload = {"model": model.model, "input": {"query": query, "documents": documents}, "parameters": {"top_n": len(documents), "return_documents": False}}
    else:
        payload = {"model": model.model, "query": query, "documents": documents, "top_n": len(documents)}
    body = _request("POST", url, key=model.secret, payload=payload, timeout=40)
    return _read_rerank(body, len(documents)), _usage_from(body)


def _read_rerank(body: dict, count: int) -> list[tuple[int, float]]:
    results = body.get("results")
    if not isinstance(results, list):
        output = body.get("output") if isinstance(body.get("output"), dict) else {}
        results = output.get("results")
    if not isinstance(results, list) or not results:
        raise ProviderError("format", "重排响应缺少结果索引。")
    parsed: list[tuple[int, float]] = []
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("index"), int):
            raise ProviderError("format", "重排结果缺少 index。")
        if not 0 <= item["index"] < count:
            raise ProviderError("format", "重排结果索引超出候选范围。")
        score = item.get("relevance_score", item.get("score"))
        parsed.append((item["index"], float(score) if isinstance(score, (int, float)) else 0.0))
    return parsed


def stream_chat(model: ModelRow, messages: list[dict]) -> Iterator[tuple[str, Usage | None]]:
    if not model.secret:
        raise ProviderError("auth", "尚未保存对话模型凭证。")
    url = _root(model.base_url)
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"
    payload = {"model": model.model, "messages": messages, "stream": True, "stream_options": {"include_usage": True}}
    headers = {"Authorization": f"Bearer {model.secret}", "Content-Type": "application/json"}
    try:
        with httpx.stream("POST", url, headers=headers, json=payload, timeout=90) as response:
            error = _classify(response)
            if error:
                raise error
            usage: Usage | None = None
            for line in response.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                import json
                try:
                    body = json.loads(data)
                except json.JSONDecodeError as exc:
                    raise ProviderError("format", "流式响应不是有效 JSON。") from exc
                if isinstance(body.get("usage"), dict):
                    usage = _usage_from(body)
                choices = body.get("choices") or []
                if choices and isinstance(choices[0], dict):
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content") or ""
                    if text:
                        yield text, None
            yield "", usage
    except ProviderError:
        raise
    except httpx.TimeoutException as exc:
        raise ProviderError("timeout", "对话模型响应超时。") from exc
    except httpx.HTTPError as exc:
        raise ProviderError("unavailable", f"无法连接对话模型：{exc}") from exc


def generate_with_langchain(model: ModelRow, messages: list[dict]) -> Iterator[tuple[str, Usage | None]]:
    """Use LangChain's OpenAI-compatible chat model when the endpoint is standard; otherwise stream via HTTP."""
    try:
        from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage
        from langchain_openai import ChatOpenAI
    except ImportError:
        yield from stream_chat(model, messages)
        return
    base = _root(model.base_url)
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    converted = []
    for item in messages:
        content = item.get("content") or ""
        if item.get("role") == "system":
            converted.append(SystemMessage(content=content))
        else:
            converted.append(HumanMessage(content=content))
    llm = ChatOpenAI(
        model=model.model,
        api_key=model.secret,
        base_url=base,
        streaming=True,
        stream_usage=True,
        timeout=90,
        max_retries=0,
    )
    usage: Usage | None = None
    try:
        for chunk in llm.stream(converted):
            if isinstance(chunk, AIMessageChunk):
                meta = getattr(chunk, "usage_metadata", None) or {}
                if meta.get("input_tokens") is not None or meta.get("output_tokens") is not None:
                    usage = Usage(
                        input_tokens=meta.get("input_tokens"),
                        output_tokens=meta.get("output_tokens"),
                    )
                text = chunk.content if isinstance(chunk.content, str) else ""
                if text:
                    yield text, None
        yield "", usage
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if "401" in message or "403" in message or "api key" in lowered or "unauthorized" in lowered:
            raise ProviderError("auth", "服务拒绝了凭证，请核对 API Key。") from exc
        if "429" in message or "rate" in lowered:
            raise ProviderError("rate", "供应商限流，请稍后重试。") from exc
        if "timeout" in lowered:
            raise ProviderError("timeout", "对话模型响应超时。") from exc
        raise ProviderError("unavailable", f"对话模型调用失败：{message[:240]}") from exc


def test_model(model: ModelRow) -> dict:
    started = time.perf_counter()
    try:
        if model.kind == "Embedding":
            vectors, usage = embed_texts(model, ["连通性测试", "第二条文本"])
            elapsed = int((time.perf_counter() - started) * 1000)
            return {"ok": True, "title": "向量测试通过", "description": f"返回 {len(vectors[0])} 维向量，批量 {len(vectors)} 条。耗时 {elapsed} ms。用量：{_usage_text(usage)}。", "dimensions": len(vectors[0])}
        if model.kind == "Rerank":
            ranked, usage = rerank(model, "年假如何申请", ["年假需提前申请", "报销需要发票"])
            elapsed = int((time.perf_counter() - started) * 1000)
            return {"ok": True, "title": "重排测试通过", "description": f"返回 {len(ranked)} 条索引与相关度。耗时 {elapsed} ms。用量：{_usage_text(usage)}。"}
        if model.kind == "LLM":
            pieces = []
            usage = None
            for text, part_usage in generate_with_langchain(model, [{"role": "system", "content": "只回复：pong"}, {"role": "user", "content": "ping"}]):
                if text:
                    pieces.append(text)
                if part_usage:
                    usage = part_usage
            if not "".join(pieces).strip():
                raise ProviderError("format", "对话模型没有返回文本。")
            elapsed = int((time.perf_counter() - started) * 1000)
            return {"ok": True, "title": "对话测试通过", "description": f"已收到流式文本。耗时 {elapsed} ms。用量：{_usage_text(usage)}。"}
        return test_docmind(model)
    except ProviderError as exc:
        titles = {"auth": "鉴权失败", "rate": "请求受限", "timeout": "响应超时", "format": "返回格式异常", "unavailable": "服务不可用"}
        return {"ok": False, "title": titles.get(exc.kind, "测试失败"), "description": exc.message}


def _usage_text(usage: Usage | None) -> str:
    if usage is None or (usage.input_tokens is None and usage.output_tokens is None):
        return "未返回"
    return f"输入 {usage.input_tokens if usage.input_tokens is not None else '未返回'} / 输出 {usage.output_tokens if usage.output_tokens is not None else '未返回'}"


def test_docmind(model: ModelRow) -> dict:
    if not model.secret or not model.access_key_id:
        return {"ok": False, "title": "鉴权失败", "description": "DocMind 需要 AccessKey ID 和 AccessKey Secret，当前未保存。"}
    try:
        client = _docmind_client(model)
        from alibabacloud_docmind_api20220711 import models as docmind_models

        client.query_doc_parser_status(docmind_models.QueryDocParserStatusRequest(id="zhixu-connectivity-check"))
        return {"ok": True, "title": "DocMind 凭证已接受", "description": "服务接受了当前 AccessKey。尚未上传文件，解析质量需要用真实文档验收。"}
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if any(token in lowered for token in ("invalidaccesskey", "signature", "forbidden", "notauthorized", "403")):
            return {"ok": False, "title": "鉴权失败", "description": "DocMind 拒绝了 AccessKey，请核对 RAM 权限与地域。"}
        if "zhixu-connectivity-check" in message or "InvalidParameter" in message or "NotFound" in message or "id" in lowered:
            return {"ok": True, "title": "DocMind 凭证已接受", "description": "服务接受了当前 AccessKey（探测任务不存在是预期结果）。解析质量需要用真实文档验收。"}
        return {"ok": False, "title": "服务不可用", "description": message[:300]}


def parse_with_docmind(model: ModelRow, path, name: str) -> list[tuple[str, str]]:
    if not model.secret or not model.access_key_id:
        raise ParseNeed("图片、扫描件或旧版 Word 需要已配置的 DocMind。")
    client = _docmind_client(model)
    from alibabacloud_docmind_api20220711 import models as docmind_models

    with open(path, "rb") as handle:
        request = docmind_models.SubmitDocParserJobAdvanceRequest(file_url_object=handle, file_name=name, llm_enhancement=False)
        submitted = client.submit_doc_parser_job_advance(request)
    job_id = _dig(submitted, "body", "data", "id") or _dig(submitted, "body", "data", "job_id")
    if not job_id:
        raise ProviderError("format", "DocMind 没有返回任务 ID。")
    status = ""
    for _ in range(45):
        time.sleep(2)
        current = client.query_doc_parser_status(docmind_models.QueryDocParserStatusRequest(id=job_id))
        status = str(_dig(current, "body", "data", "status") or "")
        if status.lower() in {"success", "succeeded"}:
            break
        if status.lower() in {"fail", "failed"}:
            raise ProviderError("unavailable", f"DocMind 解析失败：{_dig(current, 'body', 'data', 'message') or status}")
    else:
        raise ProviderError("timeout", "DocMind 解析超时，任务已保留，可稍后重试。")
    result = client.get_doc_parser_result(docmind_models.GetDocParserResultRequest(id=job_id, layout_num=0, layout_step_size=100))
    layouts = _dig(result, "body", "data", "layouts") or []
    blocks: list[tuple[str, str]] = []
    if isinstance(layouts, list):
        for layout in layouts:
            if not isinstance(layout, dict):
                layout = layout.to_map() if hasattr(layout, "to_map") else {}
            text = str(layout.get("markdownContent") or layout.get("text") or "").strip()
            page = layout.get("pageNum") or layout.get("page_num") or ""
            if text:
                blocks.append((text, f"第 {page} 页" if page else "解析片段"))
    if not blocks:
        markdown = _dig(result, "body", "data", "markdown") or _dig(result, "body", "data", "content")
        if markdown:
            blocks.append((str(markdown), "DocMind 解析结果"))
    if not blocks:
        raise ProviderError("format", "DocMind 没有返回可索引的文字或表格。")
    return blocks


class ParseNeed(Exception):
    pass


def _docmind_client(model: ModelRow):
    from alibabacloud_docmind_api20220711.client import Client
    from alibabacloud_tea_openapi import models as open_api_models

    host = urlparse(model.base_url).netloc or model.base_url.replace("https://", "").replace("http://", "")
    config = open_api_models.Config(access_key_id=model.access_key_id, access_key_secret=model.secret, endpoint=host)
    return Client(config)


def _dig(obj, *path):
    current = obj
    for key in path:
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(key)
        else:
            current = getattr(current, key, None)
    return current
