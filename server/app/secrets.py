from __future__ import annotations

from cryptography.fernet import Fernet

from .config import SECRET_PATH, ensure_dirs


def _fernet() -> Fernet:
    ensure_dirs()
    if SECRET_PATH.exists():
        key = SECRET_PATH.read_bytes()
    else:
        key = Fernet.generate_key()
        SECRET_PATH.write_bytes(key)
    return Fernet(key)


def encrypt(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return ""
    return _fernet().decrypt(value.encode()).decode()
