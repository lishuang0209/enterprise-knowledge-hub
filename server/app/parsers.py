from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass
from pathlib import Path

from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import MAX_PDF_PAGES


@dataclass
class Block:
    text: str
    location: str
    page: int = 1


class ParseError(Exception):
    pass


def extension_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def parse_file(path: Path, name: str) -> tuple[list[Block], int]:
    ext = extension_of(name)
    if ext in {"md", "markdown", "txt"}:
        return _text(path.read_text(encoding="utf-8", errors="replace")), 1
    if ext == "csv":
        return _csv(path.read_text(encoding="utf-8-sig", errors="replace")), 1
    if ext == "xlsx":
        return _xlsx(path), 1
    if ext == "xls":
        return _xls(path), 1
    if ext == "docx":
        return _docx(path), 1
    if ext == "pdf":
        return _pdf(path)
    if ext == "doc":
        raise ParseError("旧版 Word（.doc）需要配置 DocMind 后解析，或另存为 .docx。")
    if ext in {"png", "jpg", "jpeg", "webp"}:
        raise ParseError("图片需要已配置并通过测试的 DocMind 才能识别文字和表格。")
    raise ParseError(f"暂不支持的格式：{ext or '未知'}")


_HEADING = re.compile(r"^(#{1,6}\s+\S|[一二三四五六七八九十百]+、|\d{1,2}[\.、]\s*\S)")
_QA_PAIR = re.compile(
    r"(?:问|Q|问题)\s*[:：]\s*(.+?)\s*(?:\n)+\s*(?:答|A|答案)\s*[:：]\s*(.+?)(?=(?:\n\s*(?:问|Q|问题)\s*[:：])|\Z)",
    re.S,
)


def chunk_blocks(blocks: list[Block], size: int, overlap: int, mode: str = "length", separator: str = "") -> list[tuple[str, str]]:
    if mode == "paragraph":
        return _chunk_by_paragraph(blocks, size, overlap)
    if mode == "separator":
        return _chunk_by_separator(blocks, size, overlap, separator)
    if mode == "qa":
        return _explicit_qa_pairs(blocks)
    return _chunk_by_length(blocks, size, overlap)


def semantic_units(blocks: list[Block]) -> list[tuple[str, str]]:
    return [unit for section in semantic_sections(blocks) for unit in section]


def semantic_sections(blocks: list[Block]) -> list[list[tuple[str, str]]]:
    sections: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    carry = ""

    def flush(hold_heading: bool = True) -> None:
        nonlocal carry
        if not current:
            return
        if hold_heading and len(current) == 1 and _heading_only(current[0][0]) and "表格" not in current[0][1] and "工作表" not in current[0][1]:
            carry = current[0][0]
            current.clear()
            return
        chunk = list(current)
        current.clear()
        if carry:
            text, location = chunk[0]
            chunk[0] = (f"{carry}\n{text}", location)
            carry = ""
        if len(chunk) > 1 and _heading_only(chunk[0][0]):
            text, location = chunk[1]
            chunk = [(f"{chunk[0][0]}\n{text}", chunk[0][1]), *chunk[2:]]
        sections.append(chunk)

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        if text.count("```") >= 2:
            flush(False)
            sections.append([(text, block.location)])
            continue
        if "表格" in block.location or "工作表" in block.location:
            if current and "表格" not in current[-1][1] and "工作表" not in current[-1][1]:
                flush()
            current.append((text, block.location))
            continue
        for part in _heading_parts(text):
            first = part.splitlines()[0].strip()
            if _HEADING.match(first) and (current or carry):
                if carry and not current:
                    sections.append([(carry, "标题")])
                    carry = ""
                flush(False)
            sentences = _sentences(part)
            if sentences and _HEADING.match(sentences[0]) and len(sentences) > 1:
                sentences = [f"{sentences[0]}\n{sentences[1]}", *sentences[2:]]
            current.extend((sentence, block.location) for sentence in sentences)
    flush()
    if carry:
        sections.append([(carry, "标题")])
    return sections


def group_by_similarity(units: list[tuple[str, str]], vectors: list[list[float]], size: int, overlap: int) -> list[tuple[str, str]]:
    if len(vectors) != len(units):
        raise ParseError("向量条数与句子数不一致。")
    if not units:
        return []
    breaks = _topic_breaks(vectors)
    groups: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    for index, unit in enumerate(units):
        if index and breaks[index - 1]:
            groups.append(current)
            current = []
        current.append(unit)
    if current:
        groups.append(current)
    output: list[tuple[str, str]] = []
    for group in groups:
        output.extend(_merge_pieces(group, size, overlap))
    return output


def _chunk_by_length(blocks: list[Block], size: int, overlap: int) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        output.extend(_pack_text(text, block.location, size, overlap))
    return output


def _chunk_by_paragraph(blocks: list[Block], size: int, overlap: int) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    pending: list[tuple[str, str]] = []

    def flush() -> None:
        if not pending:
            return
        output.extend(_merge_pieces(pending, size, overlap))
        pending.clear()

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        if "表格" in block.location or "工作表" in block.location:
            flush()
            output.extend(_pack_text(text, block.location, size, overlap))
            continue
        for part in _heading_parts(text):
            if _HEADING.match(part):
                flush()
            pending.append((part, block.location))
            if sum(len(item) for item, _location in pending) >= size:
                flush()
    flush()
    return output


def _chunk_by_separator(blocks: list[Block], size: int, overlap: int, separator: str) -> list[tuple[str, str]]:
    divider = _decode_separator(separator)
    if not divider:
        raise ParseError("请填写自定义分隔符。")
    output: list[tuple[str, str]] = []
    for block in blocks:
        parts = [part.strip() for part in block.text.split(divider) if part.strip()]
        for index, part in enumerate(parts, start=1):
            location = block.location if len(parts) == 1 else f"{block.location} · 分隔 {index}"
            output.extend(_pack_text(part, location, size, overlap))
    return output


def _explicit_qa_pairs(blocks: list[Block]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for block in blocks:
        for question, answer in _QA_PAIR.findall(block.text):
            question, answer = question.strip(), answer.strip()
            if question and answer:
                pairs.append((f"问：{question}\n答：{answer}", block.location))
    return pairs


def _heading_parts(text: str) -> list[str]:
    if text.count("```") >= 2:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if _HEADING.match(line.strip()) and current:
            parts.append("\n".join(current).strip())
            current = [line]
        else:
            current.append(line)
    if current:
        parts.append("\n".join(current).strip())
    return [part for part in parts if part]


def _merge_pieces(pieces: list[tuple[str, str]], size: int, overlap: int) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    buf = ""
    location = ""
    for text, piece_location in pieces:
        parts = _pack_text(text, piece_location, size, overlap) if len(text) > size else [(text, piece_location)]
        for part, part_location in parts:
            if buf and len(buf) + len(part) + 2 > size:
                output.append((buf, location))
                tail = buf[-overlap:].strip() if overlap else ""
                buf = f"{tail}\n{part}".strip() if tail else part
                location = part_location
            else:
                buf = part if not buf else f"{buf}\n\n{part}"
                location = location or part_location
    if buf:
        output.append((buf, location))
    return output


def _pack_text(text: str, location: str, size: int, overlap: int) -> list[tuple[str, str]]:
    cleaned = text.strip()
    if not cleaned:
        return []
    if len(cleaned) <= size:
        return [(cleaned, location)]
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=max(200, size),
        chunk_overlap=max(0, min(overlap, max(200, size) - 50)),
        separators=["\n\n", "\n", "。", "；", "，", " "],
    )
    parts = [part.strip() for part in splitter.split_text(cleaned) if part.strip()]
    return [(part, location if len(parts) == 1 else f"{location} · 片段 {index}") for index, part in enumerate(parts, start=1)]


def _decode_separator(separator: str) -> str:
    return (separator or "").replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t")


def _sentences(text: str) -> list[str]:
    pieces = re.split(r"(?<=[。！？；])\s*|\n+", text)
    return [piece.strip() for piece in pieces if piece.strip()]


def _heading_only(text: str) -> bool:
    return "\n" not in text and bool(_HEADING.match(text.strip()))


def _topic_breaks(vectors: list[list[float]]) -> list[bool]:
    distances = [1 - _cosine(vectors[index], vectors[index + 1]) for index in range(len(vectors) - 1)]
    if not distances:
        return []
    cutoff = 0.5
    if len(distances) >= 3:
        low = min(distances)
        if low + 0.25 < max(distances):
            cutoff = max(0.5, low + 0.25)
        if len(distances) >= 4:
            cutoff = min(cutoff, max(_percentile(distances, 90), 0.5))
    return [distance > cutoff for distance in distances]


def _percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * percent / 100
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    weight = rank - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return -1
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if not left_norm or not right_norm:
        return -1
    return dot / (left_norm * right_norm)


def _text(raw: str) -> list[Block]:
    lines = raw.splitlines()
    blocks: list[Block] = []
    bucket: list[str] = []
    start = 1

    def flush(end: int) -> None:
        text = "\n".join(bucket).strip()
        if text:
            blocks.append(Block(text, f"第 {start}–{end} 行" if end != start else f"第 {start} 行"))

    for number, line in enumerate(lines, start=1):
        if line.startswith("#") and bucket:
            flush(number - 1)
            bucket = [line]
            start = number
        else:
            bucket.append(line)
    flush(max(1, len(lines)))
    return blocks or [Block(raw.strip(), "第 1 行")]


def _csv(raw: str) -> list[Block]:
    rows = list(csv.reader(raw.splitlines()))
    if not rows:
        raise ParseError("表格是空的。")
    header = rows[0]
    blocks: list[Block] = []
    for index, row in enumerate(rows[1:] or [header], start=2 if len(rows) > 1 else 1):
        pairs = [f"{header[i] if i < len(header) else f'列{i + 1}'}: {cell}" for i, cell in enumerate(row)]
        blocks.append(Block(" | ".join(pairs), f"第 {index} 行"))
    return blocks


def _xlsx(path: Path) -> list[Block]:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True, read_only=True)
    blocks: list[Block] = []
    try:
        for sheet in workbook.worksheets:
            rows = list(sheet.iter_rows(values_only=True))
            if not rows:
                continue
            header = ["" if cell is None else str(cell) for cell in rows[0]]
            data_rows = rows[1:] or rows
            start = 2 if len(rows) > 1 else 1
            for offset, row in enumerate(data_rows):
                if not any(cell is not None and str(cell).strip() for cell in row):
                    continue
                cells = []
                for index, cell in enumerate(row):
                    label = header[index] if index < len(header) and header[index] else f"列{index + 1}"
                    value = "" if cell is None else str(cell)
                    cells.append(f"{label}: {value}")
                blocks.append(Block(" | ".join(cells), f"工作表「{sheet.title}」· 第 {start + offset} 行"))
    finally:
        workbook.close()
    if not blocks:
        raise ParseError("表格中没有可读取的内容。")
    return blocks


def _xls(path: Path) -> list[Block]:
    import xlrd

    book = xlrd.open_workbook(path)
    blocks: list[Block] = []
    for sheet in book.sheets():
        if sheet.nrows == 0:
            continue
        header = [str(sheet.cell_value(0, col)) for col in range(sheet.ncols)]
        start = 1 if sheet.nrows > 1 else 0
        for row in range(start, sheet.nrows):
            cells = []
            for col in range(sheet.ncols):
                label = header[col] if col < len(header) and header[col] else f"列{col + 1}"
                cells.append(f"{label}: {sheet.cell_value(row, col)}")
            blocks.append(Block(" | ".join(cells), f"工作表「{sheet.name}」· 第 {row + 1} 行"))
    if not blocks:
        raise ParseError("表格中没有可读取的内容。")
    return blocks


def _docx(path: Path) -> list[Block]:
    import docx

    document = docx.Document(path)
    blocks: list[Block] = []
    heading = "正文"
    for index, paragraph in enumerate(document.paragraphs, start=1):
        text = paragraph.text.strip()
        if not text:
            continue
        style = paragraph.style.name if paragraph.style is not None else ""
        if style.startswith("Heading"):
            heading = text
        blocks.append(Block(text, f"{heading} · 段落 {index}"))
    for table_index, table in enumerate(document.tables, start=1):
        for row_index, row in enumerate(table.rows, start=1):
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                blocks.append(Block(" | ".join(cells), f"表格 {table_index} · 第 {row_index} 行"))
    if not blocks:
        raise ParseError("Word 文档中没有可读取的文字。")
    return blocks


def _pdf(path: Path) -> tuple[list[Block], int]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if getattr(reader, "is_encrypted", False):
        raise ParseError("PDF 已加密，无法解析。")
    total = len(reader.pages)
    if total > MAX_PDF_PAGES:
        raise ParseError(f"PDF 共 {total} 页，超过单文件 {MAX_PDF_PAGES} 页限制。")
    blocks: list[Block] = []
    for index, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            blocks.append(Block(text, f"第 {index} 页", page=index))
    blocks.extend(_pdf_table_rows(path))
    if not blocks:
        raise ParseError("PDF 没有可直接提取的文字。扫描件或图片页需要配置 DocMind。")
    return blocks, total


def _pdf_table_rows(path: Path) -> list[Block]:
    import pdfplumber

    blocks: list[Block] = []
    with pdfplumber.open(path) as pdf:
        for page_index, page in enumerate(pdf.pages, start=1):
            for table_index, table in enumerate(page.extract_tables() or [], start=1):
                rows = [row for row in table if row and any(cell and str(cell).strip() for cell in row)]
                if len(rows) < 2:
                    continue
                header = ["" if cell is None else str(cell).replace("\n", " ").strip() for cell in rows[0]]
                for offset, row in enumerate(rows[1:], start=2):
                    cells = []
                    for column, cell in enumerate(row):
                        value = "" if cell is None else str(cell).replace("\n", " ").strip()
                        if not value:
                            continue
                        label = header[column] if column < len(header) and header[column] else f"列{column + 1}"
                        cells.append(f"{label}: {value}")
                    if cells:
                        blocks.append(Block(" | ".join(cells), f"第 {page_index} 页 · 表格 {table_index} · 第 {offset} 行", page=page_index))
    return blocks
