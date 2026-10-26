from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("ZHIXU_DATA", ROOT / "data"))
FILES = DATA / "files"
DB_PATH = DATA / "zhixu.sqlite3"
SECRET_PATH = DATA / ".secret_key"

MAX_BATCH = 20
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 200

IMAGE_TYPES = {"png", "jpg", "jpeg", "webp"}
ALLOWED = {"pdf", "doc", "docx", "md", "markdown", "txt", "png", "jpg", "jpeg", "webp", "xlsx", "xls", "csv"}
ROLES = {"admin", "manager", "user"}


def ensure_dirs() -> None:
    FILES.mkdir(parents=True, exist_ok=True)
