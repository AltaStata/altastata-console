"""
FastAPI app entrypoint.

In production the multi-stage Dockerfile copies the built React assets into
``/app/static`` and this app serves them at ``/`` while keeping ``/api/*``
for the JSON API.

In development you run uvicorn standalone (no static dir is mounted) and the
Vite dev server proxies ``/api`` to it.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import files, preview, versions, account

STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/app/static"))

app = FastAPI(title="AltaStata Console", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],  # Vite dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(account.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(preview.router, prefix="/api")
app.include_router(versions.router, prefix="/api")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
