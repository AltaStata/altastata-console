"""
Pydantic models for the JSON API.

Keep in sync with frontend/src/types/index.ts.
"""
from __future__ import annotations

from pydantic import BaseModel


class FileEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int | None = None
    created: str | None = None
    version: str | None = None
    readers: list[str] = []
    encrypted: bool = False
    mime_type: str | None = None


class ListResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class VersionEntry(BaseModel):
    version: str
    created: str
    size: int
    author: str | None = None


class AccountInfo(BaseModel):
    account_id: str
    display_name: str
