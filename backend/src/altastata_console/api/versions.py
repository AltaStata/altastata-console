"""
List historical versions of a file (AltaStata uses ``filename.ext✹timestamp_version``).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query

from ..grpc_gateway import attr_value, get_gateway, split_versioned_path, to_cloud_path
from ..models import VersionEntry

router = APIRouter()


def _format_created(version_token: str) -> str:
    timestamp = version_token.split("_", 1)[0]
    if timestamp.isdigit():
        return datetime.fromtimestamp(int(timestamp) / 1000).strftime("%Y/%m/%d %H:%M:%S")
    return version_token


def _safe_int(value: str | None) -> int:
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


@router.get("/versions", response_model=list[VersionEntry])
def list_versions(path: str = Query(...)) -> list[VersionEntry]:
    gateway = get_gateway()
    cloud_path = to_cloud_path(path)

    versions = gateway.list_cloud_files_versions(
        cloud_path,
        includingSubdirectories=True,
        timeIntervalStart="",
        timeIntervalEnd="",
    )

    found: list[VersionEntry] = []
    for group in versions:
        for versioned_cloud_path in group:
            base_cloud_path, version_token = split_versioned_path(versioned_cloud_path)
            if base_cloud_path != cloud_path or not version_token:
                continue
            found.append(
                VersionEntry(
                    version=version_token,
                    created=_format_created(version_token),
                    size=_safe_int(attr_value(gateway, versioned_cloud_path, "size")),
                    author=attr_value(gateway, versioned_cloud_path, "tag"),
                )
            )

    found.sort(key=lambda item: item.version)
    return found
