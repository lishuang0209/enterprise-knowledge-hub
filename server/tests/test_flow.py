import base64
import io
import json
import os
import tempfile
import time
from pathlib import Path

os.environ["ZHIXU_DATA"] = tempfile.mkdtemp(prefix="zhixu-test-")

from fastapi.testclient import TestClient

from app.main import app
from app.providers import ModelRow
from app.providers import test_model as run_provider_test


def _wait_ready(client: TestClient, doc_id: str) -> dict:
    for _ in range(40):
        state = client.get("/api/state", headers={"X-Role": "admin"}).json()
        document = next(item for item in state["documents"] if item["id"] == doc_id)
        if document["status"] in {"ready", "failed"}:
            return document
        time.sleep(0.25)
    raise AssertionError("document was not built")


def test_import_retrieve_chat_and_roles():
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={
            "name": "人事制度", "description": "假勤与报销", "category": "制度规范", "tags": ["人事"],
            "chunkSize": 400, "overlap": 40,
        })
        assert created.status_code == 200, created.text
        kb_id = created.json()["knowledgeBases"][0]["id"]
        content = "年假需提前 3 个工作日提交申请，由直属负责人审批。\n\n出差结束后 30 个自然日内提交报销，需附交通票据和住宿发票。\n"
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id, "chunkSize": 400, "overlap": 40}, files={"files": ("假期与报销.md", io.BytesIO(content.encode()), "text/markdown")})
        assert preview.status_code == 200, preview.text
        document = preview.json()["documents"][0]
        assert document["status"] == "review"
        assert any("年假" in chunk["content"] for chunk in document["chunks"])
        built = client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": [document["id"]]})
        assert built.status_code == 200
        ready = _wait_ready(client, document["id"])
        assert ready["status"] == "ready", ready
        found = client.post(f"/api/knowledge-bases/{kb_id}/retrieve", headers={"X-Role": "manager"}, json={"question": "年假如何申请？", "limit": 3})
        assert found.status_code == 200
        assert any("年假" in hit["content"] for hit in found.json()["hits"])
        denied = client.post("/api/knowledge-bases", headers={"X-Role": "user"}, json={"name": "不该创建"})
        assert denied.status_code == 403
        with client.stream("POST", "/api/chat/stream", headers={"X-Role": "user", "Content-Type": "application/json"}, json={"question": "报销需要哪些材料？", "kbIds": [kb_id]}) as response:
            body = "".join(response.iter_text())
        assert "event: done" in body
        assert "报销" in body or "票据" in body
        logs = client.get("/api/state", headers={"X-Role": "admin"}).json()["logs"]
        assert logs and logs[0]["question"] == "报销需要哪些材料？"
        assert logs[0]["inputTokens"] is None


def test_embedding_dimension_mismatch(monkeypatch):
    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"data": [{"index": 0, "embedding": [0.1, 0.2]}, {"index": 1, "embedding": [0.2, 0.3]}], "usage": {"prompt_tokens": 4, "total_tokens": 4}}

    monkeypatch.setattr("app.providers.httpx.request", lambda *args, **kwargs: Response())
    result = run_provider_test(ModelRow(
        id="embed", provider="OpenRouter", kind="Embedding", name="测试向量", model="demo",
        base_url="https://example.com/v1", enabled=True, is_default=True, dimensions=4,
        status="untested", secret="sk-test", has_credential=True,
    ))
    assert result["ok"] is False
    assert "维度" in result["description"]


def test_docx_and_xlsx_parse(tmp_path):
    from docx import Document
    from openpyxl import Workbook

    from app.parsers import parse_file

    document = Document()
    document.add_heading("请假制度", level=1)
    document.add_paragraph("年假需提前三个工作日申请。")
    docx_path = tmp_path / "leave.docx"
    document.save(docx_path)
    blocks, _pages = parse_file(docx_path, "leave.docx")
    assert any("年假" in block.text for block in blocks)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "服务"
    sheet.append(["问题", "处理方式"])
    sheet.append(["忘记密码", "通过邮箱重置"])
    xlsx_path = tmp_path / "faq.xlsx"
    workbook.save(xlsx_path)
    rows, _pages = parse_file(xlsx_path, "faq.xlsx")
    assert any("忘记密码" in block.text and "工作表「服务」" in block.location for block in rows)
    assert json.dumps([block.location for block in rows], ensure_ascii=False)


FIXTURES = Path(__file__).parent / "fixtures"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def _upload(client: TestClient, kb_id: str, name: str, data: bytes, mime: str):
    return client.post(
        "/api/documents/preview",
        headers={"X-Role": "manager"},
        data={"kbId": kb_id, "chunkSize": 800, "overlap": 40},
        files={"files": (name, io.BytesIO(data), mime)},
    )


def test_formats_duplicate_recovery_and_missing_evidence():
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "格式样本", "chunkSize": 800, "overlap": 40})
        assert created.status_code == 200, created.text
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "格式样本")
        samples = {
            "请假制度.docx": FIXTURES.joinpath("请假制度.docx").read_bytes(),
            "服务标准.xlsx": FIXTURES.joinpath("服务标准.xlsx").read_bytes(),
            "假期额度.xls": FIXTURES.joinpath("假期额度.xls").read_bytes(),
            "办公规范.pdf": FIXTURES.joinpath("办公规范.pdf").read_bytes(),
            "设备.png": PNG,
            "旧版.doc": b"not-a-real-doc",
        }
        mimes = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xls": "application/vnd.ms-excel", "pdf": "application/pdf", "png": "image/png", "doc": "application/msword"}
        preview = client.post(
            "/api/documents/preview",
            headers={"X-Role": "manager"},
            data={"kbId": kb_id, "chunkSize": 800, "overlap": 40},
            files=[("files", (name, io.BytesIO(data), mimes[name.rsplit(".", 1)[-1]])) for name, data in samples.items()],
        )
        assert preview.status_code == 200, preview.text
        documents = {item["name"]: item for item in preview.json()["documents"]}
        assert any("事假" in chunk["content"] and "表格 1" in chunk["location"] for chunk in documents["请假制度.docx"]["chunks"])
        assert any("工作表「升级」" in chunk["location"] and "30分钟" in chunk["content"] for chunk in documents["服务标准.xlsx"]["chunks"])
        assert any("工作表「假期」" in chunk["location"] and "调休" in chunk["content"] for chunk in documents["假期额度.xls"]["chunks"])
        assert any("第 1 页 · 表格 1 · 第 2 行" in chunk["location"] and "显示器" in chunk["content"] for chunk in documents["办公规范.pdf"]["chunks"])
        assert documents["设备.png"]["status"] == "failed" and "DocMind" in documents["设备.png"]["error"]
        assert documents["旧版.doc"]["status"] == "failed" and "DocMind" in documents["旧版.doc"]["error"]
        ready_ids = [item["id"] for item in documents.values() if item["status"] == "review"]
        assert client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": ready_ids}).status_code == 200
        for doc_id in ready_ids:
            assert _wait_ready(client, doc_id)["status"] == "ready"
        found = client.post(f"/api/knowledge-bases/{kb_id}/retrieve", headers={"X-Role": "manager"}, json={"question": "显示器怎么领用？", "limit": 3})
        assert any("资产编号" in hit["content"] and "表格" in hit["location"] for hit in found.json()["hits"])
        duplicate = _upload(client, kb_id, "请假制度.docx", samples["请假制度.docx"], mimes["docx"])
        assert duplicate.json()["documents"][0]["status"] == "failed"
        assert "相同文件" in duplicate.json()["documents"][0]["error"]
        xls_id = documents["假期额度.xls"]["id"]
        assert client.post("/api/documents/delete", headers={"X-Role": "manager"}, json={"ids": [xls_id]}).status_code == 200
        again = _upload(client, kb_id, "假期额度.xls", samples["假期额度.xls"], mimes["xls"])
        assert again.json()["documents"][0]["status"] == "review"
        from app.db import Document, SessionLocal
        from app.main import recover_interrupted_jobs

        pdf_id = documents["办公规范.pdf"]["id"]
        with SessionLocal() as db:
            row = db.get(Document, pdf_id)
            row.status = "indexing"
            db.commit()
        recover_interrupted_jobs()
        assert _wait_ready(client, pdf_id)["status"] == "ready"
        other = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "空知识库"})
        empty_id = next(item["id"] for item in other.json()["knowledgeBases"] if item["name"] == "空知识库")
        with client.stream("POST", "/api/chat/stream", headers={"X-Role": "user", "Content-Type": "application/json"}, json={"question": "火星基地的发射窗口是什么时候？", "kbIds": [empty_id]}) as response:
            body = "".join(response.iter_text())
        assert "没有找到足以回答这个问题的依据" in body
        isolated = client.post(f"/api/knowledge-bases/{empty_id}/retrieve", headers={"X-Role": "manager"}, json={"question": "显示器怎么领用？", "limit": 3})
        assert isolated.json()["hits"] == []


def test_fastgpt_style_chunk_modes():
    from app.parsers import Block, chunk_blocks

    blocks = [
        Block("一、年假\n年假需提前申请。", "第 1 行"),
        Block("负责人审批后生效。", "第 2 行"),
        Block("假期 | 规则", "第 1 页 · 表格 1 · 第 1 行"),
        Block("二、报销\n出差结束后提交报销。", "第 3 行"),
    ]
    paragraph = chunk_blocks(blocks, 200, 0, mode="paragraph")
    assert any(text.startswith("一、年假") and "审批" in text and "二、报销" not in text for text, _location in paragraph)
    assert any(text == "假期 | 规则" for text, _location in paragraph)
    assert any(text.startswith("二、报销") for text, _location in paragraph)
    separator = chunk_blocks([Block("第一条---第二条", "第 1 行")], 200, 0, mode="separator", separator="---")
    assert [text for text, _location in separator] == ["第一条", "第二条"]
    qa = chunk_blocks([Block("问：年假怎么申请？\n答：提前 3 天。\n问：报销何时交？\n答：30 天内。", "第 1 行")], 800, 0, mode="qa")
    assert len(qa) == 2
    assert qa[0][0].startswith("问：年假怎么申请？")
    assert "提前 3 天" in qa[0][0]


def test_semantic_split_groups_topics_and_needs_embedding(monkeypatch):
    from app.parsers import group_by_similarity
    from app.providers import Usage

    units = [
        ("年假需提前申请。", "第 1 行"),
        ("负责人审批后生效。", "第 2 行"),
        ("出差结束后提交报销。", "第 3 行"),
        ("需附交通票据。", "第 4 行"),
    ]
    vectors = [[1.0, 0.0], [0.98, 0.1], [0.0, 1.0], [0.1, 0.99]]
    grouped = group_by_similarity(units, vectors, 800, 0)
    assert len(grouped) == 2
    assert "年假" in grouped[0][0] and "审批" in grouped[0][0] and "报销" not in grouped[0][0]
    assert "报销" in grouped[1][0] and "票据" in grouped[1][0]

    def embed(model, texts):
        return ([[0.0, 1.0] if "报销" in text or "票据" in text else [1.0, 0.0] for text in texts], Usage())

    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "语义分段", "description": "", "category": "通用知识", "tags": []})
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "语义分段")
        content = "一、年假\n年假需提前申请。负责人审批后生效。\n二、报销\n出差结束后提交报销。需附交通票据和住宿发票。\n"
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id}, files={"files": ("制度.md", io.BytesIO(content.encode()), "text/markdown")})
        doc_id = preview.json()["documents"][0]["id"]
        monkeypatch.setattr("app.pipeline.default_model", lambda db, kind: None)
        missing = client.post(f"/api/documents/{doc_id}/rechunk", headers={"X-Role": "manager"}, json={"chunkSize": 800, "overlap": 40, "chunkMode": "semantic", "save": False})
        assert missing.status_code == 400
        assert "向量模型" in missing.json()["detail"]
        monkeypatch.setattr("app.pipeline.default_model", lambda db, kind: ModelRow(
            id="embed", provider="通义", kind="Embedding", name="测试向量", model="demo",
            base_url="https://example.com/v1", enabled=True, is_default=True, dimensions=2,
            status="verified", secret="sk-test", has_credential=True,
        ) if kind == "Embedding" else None)
        monkeypatch.setattr("app.providers.embed_texts", embed)
        looked = client.post(f"/api/documents/{doc_id}/rechunk", headers={"X-Role": "manager"}, json={"chunkSize": 800, "overlap": 40, "chunkMode": "semantic", "save": False})
        assert looked.status_code == 200, looked.text
        chunks = looked.json()["chunks"]
        assert any("年假" in item["content"] and "报销" not in item["content"] for item in chunks)
        assert any("报销" in item["content"] and "年假" not in item["content"] for item in chunks)
        state = client.get("/api/state", headers={"X-Role": "manager"}).json()
        document = next(item for item in state["documents"] if item["id"] == doc_id)
        assert document["status"] == "review"
        assert next(item["chunkMode"] for item in state["knowledgeBases"] if item["id"] == kb_id) == "length"


def test_rechunk_previews_then_rebuilds_one_document():
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "单文件分段", "description": "", "category": "通用知识", "tags": [], "chunkSize": 800, "overlap": 40})
        kb_id = created.json()["knowledgeBases"][0]["id"]
        content = "年假需提前申请并由负责人审批。" * 40
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id, "chunkSize": 800, "overlap": 40}, files={"files": ("规则.md", io.BytesIO(content.encode()), "text/markdown")})
        doc_id = preview.json()["documents"][0]["id"]
        looked = client.post(f"/api/documents/{doc_id}/rechunk", headers={"X-Role": "manager"}, json={"chunkSize": 300, "overlap": 20, "save": False})
        assert looked.status_code == 200, looked.text
        assert len(looked.json()["chunks"]) > 1
        assert client.get("/api/state", headers={"X-Role": "manager"}).json()["knowledgeBases"][0]["chunkSize"] == 800
        saved = client.post(f"/api/documents/{doc_id}/rechunk", headers={"X-Role": "manager"}, json={"chunkSize": 300, "overlap": 20, "save": True})
        assert saved.status_code == 200, saved.text
        state = saved.json()["state"]
        document = next(item for item in state["documents"] if item["id"] == doc_id)
        assert next(item["chunkSize"] for item in state["knowledgeBases"] if item["id"] == kb_id) == 300
        assert document["status"] in {"queued", "indexing", "ready"}
        assert len(saved.json()["chunks"]) > 1


def test_changing_chunk_size_repreviews_the_same_file():
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "分段预览", "description": "", "category": "通用知识", "tags": []})
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "分段预览")
        content = "年假需提前申请并由负责人审批。" * 40
        first = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id, "chunkSize": 800, "overlap": 40}, files={"files": ("规则.md", io.BytesIO(content.encode()), "text/markdown")})
        assert first.status_code == 200, first.text
        original = first.json()["documents"][0]
        assert original["status"] == "review" and original["chunks"]
        second = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id, "chunkSize": 300, "overlap": 20}, files={"files": ("规则.md", io.BytesIO(content.encode()), "text/markdown")})
        assert second.status_code == 200, second.text
        updated = second.json()["documents"][0]
        assert updated["id"] == original["id"]
        assert updated["status"] == "review"
        assert len(updated["chunks"]) > len(original["chunks"])
        built = client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": [updated["id"]]})
        assert built.status_code == 200
        assert _wait_ready(client, updated["id"])["status"] == "ready"
        duplicate = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id, "chunkSize": 300, "overlap": 20}, files={"files": ("规则.md", io.BytesIO(content.encode()), "text/markdown")})
        assert duplicate.json()["documents"][0]["status"] == "failed"
        assert "相同文件" in duplicate.json()["documents"][0]["error"]


def test_document_metadata_is_indexed_without_replacing_source():
    from app.pipeline import extract_metadata_rules

    rules = extract_metadata_rules("信誉分规则.docx", "更新日期：2026-09-01\n版本：V2.1\n负责人：安全中心\n一、信誉分\n每个账号满分 100 分。")
    assert rules["documentDate"].startswith("2026-09")
    assert "2.1" in rules["version"]
    assert any("安全中心" in item for item in rules["owners"])
    assert "信誉分" in rules["keywords"]
    assert rules["questions"] == []
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "元数据索引", "description": "", "category": "通用知识", "tags": []})
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "元数据索引")
        content = "更新日期：2026-09-01\n版本：V2.1\n负责人：安全中心\n每个账号满分 100 分。\n"
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id}, files={"files": ("信誉分规则.md", io.BytesIO(content.encode()), "text/markdown")})
        assert preview.status_code == 200, preview.text
        document = preview.json()["documents"][0]
        assert document["metadataStatus"] == "fallback"
        assert document["metadata"]["documentDate"].startswith("2026-09")
        assert document["metadata"]["owners"]
        revised = client.patch(f"/api/documents/{document['id']}/metadata", headers={"X-Role": "manager"}, json={
            "documentDate": "2026-09-01", "version": "V2.1", "subjects": ["信誉分"], "owners": ["安全中心"],
            "keywords": ["星港调度"], "questions": ["星港调度怎么申请？"],
        })
        assert revised.status_code == 200, revised.text
        saved = next(item for item in revised.json()["documents"] if item["id"] == document["id"])
        assert saved["status"] == "review" and saved["metadataStatus"] == "edited"
        built = client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": [document["id"]]})
        assert built.status_code == 200
        ready = _wait_ready(client, document["id"])
        assert ready["status"] == "ready"
        assert ready["metadataStatus"] == "edited"
        assert ready["metadata"]["keywords"] == ["星港调度"]
        found = client.post(f"/api/knowledge-bases/{kb_id}/retrieve", headers={"X-Role": "manager"}, json={"question": "星港调度怎么申请？", "limit": 3})
        assert found.status_code == 200
        hits = found.json()["hits"]
        assert hits and any("满分" in hit["content"] for hit in hits)
        assert all("星港调度" not in hit["content"] for hit in hits)


def test_metadata_model_failure_keeps_local_rules(monkeypatch):
    calls = {"n": 0}

    def broken(*_args, **_kwargs):
        calls["n"] += 1
        raise RuntimeError("模型超时")

    monkeypatch.setattr("app.pipeline.generate_with_langchain", broken)
    monkeypatch.setattr("app.pipeline.default_model", lambda _db, kind: ModelRow(
        id="llm", provider="通义", kind="LLM", name="测试对话", model="qwen-test",
        base_url="https://example.com/v1", enabled=True, is_default=True, dimensions=0,
        status="verified", secret="sk-test", has_credential=True,
    ) if kind == "LLM" else None)
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "元数据降级", "description": "", "category": "通用知识", "tags": []})
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "元数据降级")
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id}, files={"files": ("制度.md", io.BytesIO("负责人：行政部\n年假需提前申请。".encode()), "text/markdown")})
        parsed = preview.json()["documents"][0]
        doc_id = parsed["id"]
        assert parsed["metadataStatus"] == "fallback"
        assert calls["n"] == 1
        assert client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": [doc_id]}).status_code == 200
        ready = _wait_ready(client, doc_id)
        assert ready["status"] == "ready"
        assert ready["metadataStatus"] == "fallback"
        assert ready["metadataModel"] == "本机规则"
        assert "本机规则" in ready["metadataError"]
        assert any("行政部" in item for item in ready["metadata"]["owners"])
        assert calls["n"] == 1


def test_import_extracts_metadata_before_build(monkeypatch):
    calls = {"n": 0}

    def generated(*_args, **_kwargs):
        calls["n"] += 1
        payload = json.dumps({
            "documentDate": "2026-09-01", "version": "V2.1", "subjects": ["信誉分"],
            "owners": ["安全中心"], "keywords": ["星港调度"], "questions": ["星港调度怎么申请？"],
        }, ensure_ascii=False)
        yield payload, None

    monkeypatch.setattr("app.pipeline.generate_with_langchain", generated)
    monkeypatch.setattr("app.pipeline.default_model", lambda _db, kind: ModelRow(
        id="llm", provider="通义", kind="LLM", name="测试对话", model="qwen-test",
        base_url="https://example.com/v1", enabled=True, is_default=True, dimensions=0,
        status="verified", secret="sk-test", has_credential=True,
    ) if kind == "LLM" else None)
    with TestClient(app) as client:
        created = client.post("/api/knowledge-bases", headers={"X-Role": "manager"}, json={"name": "导入即抽取", "description": "", "category": "通用知识", "tags": []})
        kb_id = next(item["id"] for item in created.json()["knowledgeBases"] if item["name"] == "导入即抽取")
        content = "更新日期：2026-09-01\n版本：V2.1\n负责人：安全中心\n每个账号满分 100 分。\n"
        preview = client.post("/api/documents/preview", headers={"X-Role": "manager"}, data={"kbId": kb_id}, files={"files": ("信誉分规则.md", io.BytesIO(content.encode()), "text/markdown")})
        assert preview.status_code == 200, preview.text
        document = preview.json()["documents"][0]
        assert document["status"] == "review"
        assert document["metadataStatus"] == "ready"
        assert document["metadata"]["keywords"] == ["星港调度"]
        assert calls["n"] == 1
        assert client.post("/api/documents/build", headers={"X-Role": "manager"}, json={"ids": [document["id"]]}).status_code == 200
        ready = _wait_ready(client, document["id"])
        assert ready["metadataStatus"] == "ready"
        assert ready["metadata"]["keywords"] == ["星港调度"]
        assert calls["n"] == 1
        found = client.post(f"/api/knowledge-bases/{kb_id}/retrieve", headers={"X-Role": "manager"}, json={"question": "星港调度怎么申请？", "limit": 3})
        hits = found.json()["hits"]
        assert hits and any("满分" in hit["content"] for hit in hits)
        assert all("星港调度" not in hit["content"] for hit in hits)


def test_one_provider_key_fills_three_services():
    with TestClient(app) as client:
        saved = client.post("/api/models/share-key", headers={"X-Role": "admin"}, json={"provider": "通义", "apiKey": "sk-shared-demo", "models": [{"kind": "LLM", "model": "qwen-max"}, {"kind": "Embedding", "model": "text-embedding-v3", "dimensions": 1024}, {"kind": "Rerank", "model": "qwen3-rerank"}]})
        assert saved.status_code == 200, saved.text
        tongyi = [item for item in saved.json()["models"] if item["provider"] == "通义"]
        assert {item["kind"] for item in tongyi} == {"LLM", "Embedding", "Rerank"}
        assert all(item["hasCredential"] and item["enabled"] and item["isDefault"] and item["status"] == "untested" for item in tongyi)
        assert next(item["model"] for item in tongyi if item["kind"] == "LLM") == "qwen-max"
        assert next(item["model"] for item in tongyi if item["kind"] == "Embedding") == "text-embedding-v3"
        moved = client.post("/api/models/share-key", headers={"X-Role": "admin"}, json={"provider": "OpenRouter", "apiKey": "sk-shared-demo", "models": [{"kind": "LLM", "model": "openai/gpt-4.1-mini"}]})
        assert moved.status_code == 200, moved.text
        llm_id = next(item["id"] for item in tongyi if item["kind"] == "LLM")
        removed = client.delete(f"/api/models/{llm_id}", headers={"X-Role": "admin"})
        assert removed.status_code == 200, removed.text
        restored = client.post("/api/models/share-key", headers={"X-Role": "admin"}, json={"provider": "通义", "apiKey": "sk-shared-demo", "models": [{"kind": "LLM", "model": "qwen-plus"}, {"kind": "Embedding", "model": "text-embedding-v3", "dimensions": 1024}, {"kind": "Rerank", "model": "qwen3-rerank"}]})
        assert restored.status_code == 200, restored.text
        restored_tongyi = [item for item in restored.json()["models"] if item["provider"] == "通义"]
        assert {item["kind"] for item in restored_tongyi} == {"LLM", "Embedding", "Rerank"}
        assert next(item["model"] for item in restored_tongyi if item["kind"] == "LLM") == "qwen-plus"
        assert client.post("/api/models/share-key", headers={"X-Role": "user"}, json={"provider": "通义", "apiKey": "sk-shared-demo"}).status_code == 403
        assert client.post("/api/models/share-key", headers={"X-Role": "admin"}, json={"provider": "通义", "apiKey": "short"}).status_code == 400
