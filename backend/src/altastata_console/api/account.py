"""Account info endpoint."""
from __future__ import annotations

import os

from fastapi import APIRouter

from ..models import AccountInfo

router = APIRouter()


@router.get("/account", response_model=AccountInfo)
def get_account() -> AccountInfo:
    # Local-dev defaults mirror the JavaFX test account ("bob123").
    # Override with env vars to avoid hardcoding credentials in git.
    return AccountInfo(
        account_id=os.getenv("ALTASTATA_ACCOUNT_ID", "amazon.rsa.bob123"),
        display_name=os.getenv("ALTASTATA_DISPLAY_NAME", "bob123"),
    )
