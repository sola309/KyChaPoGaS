"""Settings router — read/update runtime config (API keys, provider choices)."""
from fastapi import APIRouter
from pydantic import BaseModel

from app.services import settings_store as S
from app.services import llm_provider

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("/")
def get_settings():
    return {
        "settings": S.public_view(),
        "llm_providers": llm_provider.available_providers(),
        "llm_selected": llm_provider.resolve("auto"),
    }


class Update(BaseModel):
    values: dict[str, str]


@router.put("/")
def update_settings(body: Update):
    S.set_many(body.values)
    return {"ok": True, "settings": S.public_view(),
            "llm_providers": llm_provider.available_providers(),
            "llm_selected": llm_provider.resolve("auto")}
