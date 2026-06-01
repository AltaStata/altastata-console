"""List directory entries via AltaStata gRPC."""
from __future__ import annotations

import mimetypes
from datetime import datetime

from fastapi import APIRouter, Query

from ..models import FileEntry, ListResponse
from ..grpc_gateway import (
    attr_value,
    get_gateway,
    normalize_api_path,
    split_versioned_path,
    to_api_path,
    to_cloud_path,
)

router = APIRouter()


def _format_created(version_token: str | None) -> str | None:
    if not version_token:
        return None
    timestamp = version_token.split("_", 1)[0]
    if not timestamp.isdigit():
        return None
    return datetime.fromtimestamp(int(timestamp) / 1000).strftime("%Y/%m/%d %H:%M:%S")


def _safe_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_readers(value: str | None) -> list[str]:
    if value is None:
        return []
    readers = [item.strip() for item in value.replace("\r", "\n").split("\n")]
    return [reader for reader in readers if reader]


@router.get("/files", response_model=ListResponse)
def list_files(path: str = Query("/")) -> ListResponse:
    gateway = get_gateway()
    api_path = normalize_api_path(path)
    cloud_prefix = to_cloud_path(api_path)
    prefix = f"{cloud_prefix}/" if cloud_prefix else ""

    version_groups = gateway.list_cloud_files_versions(
        cloud_prefix,
        includingSubdirectories=True,
        timeIntervalStart="",
        timeIntervalEnd="",
    )

    directory_children: set[str] = set()
    file_versions: dict[str, str] = {}

    for versions in version_groups:
        for versioned_cloud_path in versions:
            cloud_path, version_token = split_versioned_path(versioned_cloud_path)
            if prefix:
                if not cloud_path.startswith(prefix):
                    continue
                relative = cloud_path[len(prefix):]
            else:
                relative = cloud_path

            if not relative:
                continue

            head = relative.split("/", 1)[0]
            child_cloud_path = f"{cloud_prefix}/{head}" if cloud_prefix else head
            has_subpath = "/" in relative

            if has_subpath:
                directory_children.add(child_cloud_path)
                continue

            current = file_versions.get(child_cloud_path)
            if current is None or (version_token and version_token > current):
                file_versions[child_cloud_path] = version_token or ""

    entries: list[FileEntry] = []
    for child_cloud_path in sorted(directory_children, key=str.lower):
        name = child_cloud_path.split("/")[-1]
        entries.append(
            FileEntry(
                name=name,
                path=to_api_path(child_cloud_path),
                is_dir=True,
            )
        )

    for child_cloud_path in sorted(file_versions.keys(), key=str.lower):
        name = child_cloud_path.split("/")[-1]
        version = file_versions[child_cloud_path] or None
        versioned_cloud_path = (
            f"{child_cloud_path}✹{version}" if version else child_cloud_path
        )
        size = _safe_int(attr_value(gateway, versioned_cloud_path, "size"))
        readers = _safe_readers(attr_value(gateway, versioned_cloud_path, "readers"))
        mime_type, _ = mimetypes.guess_type(name)

        entries.append(
            FileEntry(
                name=name,
                path=to_api_path(child_cloud_path),
                is_dir=False,
                size=size,
                created=_format_created(version),
                version=version,
                readers=readers,
                mime_type=mime_type,
            )
        )

    return ListResponse(path=api_path, entries=entries)
