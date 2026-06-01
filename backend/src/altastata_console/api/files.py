"""List directory entries via AltaStata gRPC."""
from __future__ import annotations

import mimetypes
import queue
import threading
import zipfile
from collections.abc import Iterator
from datetime import datetime
from pathlib import PurePosixPath

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..models import FileEntry, ListResponse
from ..grpc_gateway import (
    attr_value,
    build_versioned_path,
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


def _safe_zip_relative_path(path: str) -> str:
    normalized = PurePosixPath(path.strip().lstrip("/")).as_posix()
    if not normalized or normalized == ".":
        raise ValueError("Empty relative path")
    parts = [part for part in normalized.split("/") if part not in {"", "."}]
    if any(part == ".." for part in parts):
        raise ValueError("Parent path segments are not allowed")
    return "/".join(parts)


class _QueueWriter:
    def __init__(self, out_queue: queue.Queue[bytes | Exception | None]) -> None:
        self._out_queue = out_queue
        self._offset = 0
        self._closed = False

    def write(self, data: bytes) -> int:
        if self._closed:
            return 0
        if data:
            self._out_queue.put(bytes(data))
            self._offset += len(data)
        return len(data)

    def tell(self) -> int:
        return self._offset

    def flush(self) -> None:
        return None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._out_queue.put(None)

    @property
    def closed(self) -> bool:
        return self._closed


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


@router.get("/download-directory-zip")
def download_directory_zip(path: str = Query(...)) -> StreamingResponse:
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

    latest_version_by_file: dict[str, str] = {}
    for versions in version_groups:
        for versioned_cloud_path in versions:
            cloud_path, version_token = split_versioned_path(versioned_cloud_path)
            if not version_token:
                continue
            if prefix and not cloud_path.startswith(prefix):
                continue
            if cloud_path == cloud_prefix:
                continue
            current = latest_version_by_file.get(cloud_path)
            if current is None or version_token > current:
                latest_version_by_file[cloud_path] = version_token

    if not latest_version_by_file:
        raise HTTPException(status_code=404, detail="No files found in directory")

    dir_name = PurePosixPath(api_path).name or "root"
    filename = f"{dir_name}.zip"

    output_queue: queue.Queue[bytes | Exception | None] = queue.Queue(maxsize=16)

    def _producer() -> None:
        writer = _QueueWriter(output_queue)
        try:
            with zipfile.ZipFile(
                writer,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
                allowZip64=True,
            ) as zipf:
                for cloud_path in sorted(latest_version_by_file.keys(), key=str.lower):
                    version_token = latest_version_by_file[cloud_path]
                    relative_raw = cloud_path[len(prefix):] if prefix else cloud_path
                    try:
                        relative_path = _safe_zip_relative_path(relative_raw)
                    except ValueError:
                        continue
                    versioned_cloud_path = build_versioned_path(cloud_path, version_token)
                    stream = gateway.get_java_input_stream(
                        versioned_cloud_path,
                        snapshot_time=None,
                        start_position=0,
                        how_many_chunks_in_parallel=4,
                    )
                    with zipf.open(relative_path, "w") as target:
                        for chunk in stream:
                            if chunk:
                                target.write(bytes(chunk))
        except Exception as exc:
            output_queue.put(exc)
        finally:
            writer.close()

    producer = threading.Thread(target=_producer, name="zip-stream-producer", daemon=True)
    producer.start()

    def iter_archive() -> Iterator[bytes]:
        while True:
            item = output_queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            if item:
                yield item

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(iter_archive(), media_type="application/zip", headers=headers)
