from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from altastata import AltaStataFunctions, GrpcEndpoint
from fastapi import HTTPException


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _account_id() -> str:
    return os.getenv("ALTASTATA_ACCOUNT_ID", "amazon.rsa.bob123")


def _default_account_dir() -> Path:
    return Path.home() / ".altastata" / "accounts" / _account_id()


def _user_name() -> str:
    explicit = os.getenv("ALTASTATA_GRPC_USER_NAME")
    if explicit:
        return explicit
    return _account_id().split(".")[-1]


def normalize_api_path(path: str) -> str:
    value = (path or "/").strip()
    if not value.startswith("/"):
        value = f"/{value}"
    if value != "/":
        value = value.rstrip("/")
    return value


def to_cloud_path(path: str) -> str:
    normalized = normalize_api_path(path)
    return normalized.lstrip("/")


def to_api_path(cloud_path: str) -> str:
    stripped = (cloud_path or "").strip().strip("/")
    if not stripped:
        return "/"
    return f"/{stripped}"


def split_versioned_path(cloud_path: str) -> tuple[str, str | None]:
    if "✹" not in cloud_path:
        return cloud_path, None
    base, version = cloud_path.split("✹", 1)
    return base, version


def build_versioned_path(cloud_path: str, version: str | None) -> str:
    if not version:
        return cloud_path
    if "✹" in cloud_path:
        return cloud_path
    return f"{cloud_path}✹{version}"


@lru_cache(maxsize=1)
def _grpc_gateway() -> AltaStataFunctions:
    account_dir = Path(
        os.getenv("ALTASTATA_ACCOUNT_DIR", str(_default_account_dir()))
    ).expanduser()
    if not account_dir.exists():
        raise FileNotFoundError(
            f"AltaStata account directory not found: {account_dir}. "
            "Set ALTASTATA_ACCOUNT_DIR or create ~/.altastata/accounts/<account-id>."
        )

    endpoint = GrpcEndpoint(
        host=os.getenv("ALTASTATA_GRPC_HOST", "127.0.0.1"),
        port=int(os.getenv("ALTASTATA_GRPC_PORT", "9877")),
        secure=_env_bool("ALTASTATA_GRPC_SECURE", False),
    )

    return AltaStataFunctions.from_account_dir(
        account_dir_path=str(account_dir),
        transport="grpc",
        password=os.getenv("ALTASTATA_PASSWORD"),
        user_name=_user_name(),
        grpc_endpoint=endpoint,
        grpc_setup_port=int(os.getenv("ALTASTATA_GRPC_SETUP_PORT", "9880")),
        grpc_auto_start_server=_env_bool("ALTASTATA_GRPC_AUTO_START_SERVER", True),
    )


def get_gateway() -> AltaStataFunctions:
    try:
        return _grpc_gateway()
    except Exception as exc:  # pragma: no cover - defensive path
        raise HTTPException(
            status_code=503,
            detail=f"gRPC gateway initialization failed: {exc}",
        ) from exc


def attr_value(gateway: AltaStataFunctions, cloud_path: str, name: str) -> str | None:
    value: Any = gateway.get_file_attribute(cloud_path, None, name)
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None
