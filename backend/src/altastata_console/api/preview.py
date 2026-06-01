"""
Stream a file (or a specific version) for inline browser preview.
"""
from __future__ import annotations

import mimetypes
from collections.abc import Iterator

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from ..grpc_gateway import build_versioned_path, get_gateway, to_cloud_path

router = APIRouter()


@router.get("/preview")
def preview_file(
    path: str = Query(...),
    version: str | None = Query(None),
) -> StreamingResponse:
    gateway = get_gateway()
    cloud_path = to_cloud_path(path)
    versioned_path = build_versioned_path(cloud_path, version)
    mime_type, _ = mimetypes.guess_type(cloud_path)

    stream = gateway.get_java_input_stream(
        versioned_path,
        snapshot_time=None,
        start_position=0,
        how_many_chunks_in_parallel=4,
    )

    def iter_bytes() -> Iterator[bytes]:
        for chunk in stream:
            if chunk:
                yield bytes(chunk)

    return StreamingResponse(iter_bytes(), media_type=mime_type or "application/octet-stream")
