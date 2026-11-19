"""제공자가 지금 서빙하는 모델 목록을 받아온다.

모델을 코드에 박아 두지 않는다. 각 제공자의 목록 API를 그때그때 조회하고,
조회가 안 되더라도(키 없음, 오프라인) 사용자는 모델 이름을 직접 입력해서 쓸 수 있다.
목록 조회는 과금되지 않는 메타데이터 요청이다.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .factory import test_model_names
from .store import ProviderError, ProviderStore, ResolvedProvider

_TTL_SEC = 600
_cache: dict[str, tuple[float, list[dict]]] = {}


def _entry(model_id: str, label: str | None = None, **extra: Any) -> dict:
    return {"id": model_id, "label": label or model_id, **{k: v for k, v in extra.items() if v is not None}}


async def list_models(provider_id: str, store: ProviderStore, *, refresh: bool = False) -> dict:
    """{'models': [...], 'error': str|None}. 실패해도 예외를 던지지 않는다."""
    fake = test_model_names(provider_id)
    if fake:
        return {"models": [{"id": name, "label": name} for name in fake], "error": None}
    try:
        p = store.resolve(provider_id)
    except ProviderError as e:
        return {"models": [], "error": str(e)}

    cache_key = f"{p.id}|{p.base_url}|{bool(p.api_key)}|{sorted(p.extra.items())}"
    hit = _cache.get(cache_key)
    if hit and not refresh and time.time() - hit[0] < _TTL_SEC:
        return {"models": hit[1], "error": None}

    try:
        models = await _fetch(p)
    except httpx.HTTPStatusError as e:
        code = e.response.status_code
        hint = "키가 틀렸거나 권한이 없습니다." if code in (401, 403) else "제공자가 요청을 거절했습니다."
        return {"models": [], "error": f"모델 목록을 받지 못했습니다 (HTTP {code}). {hint}"}
    except httpx.HTTPError as e:
        return {"models": [], "error": f"제공자에 연결하지 못했습니다: {type(e).__name__}"}
    except ProviderError as e:
        return {"models": [], "error": str(e)}
    except Exception as e:
        return {"models": [], "error": f"모델 목록을 받지 못했습니다: {type(e).__name__}: {e}"}

    models.sort(key=lambda m: m["id"])
    _cache[cache_key] = (time.time(), models)
    return {"models": models, "error": None}


async def _fetch(p: ResolvedProvider) -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as http:
        if p.kind == "google":
            r = await http.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"pageSize": 1000},
                headers={"x-goog-api-key": p.api_key or ""},
            )
            r.raise_for_status()
            out = []
            for m in r.json().get("models", []):
                if "generateContent" not in m.get("supportedGenerationMethods", []):
                    continue
                out.append(
                    _entry(
                        m["name"].removeprefix("models/"),
                        m.get("displayName"),
                        context=m.get("inputTokenLimit"),
                    )
                )
            return out

        if p.kind == "anthropic":
            r = await http.get(
                "https://api.anthropic.com/v1/models",
                params={"limit": 1000},
                headers={"x-api-key": p.api_key or "", "anthropic-version": "2023-06-01"},
            )
            r.raise_for_status()
            return [_entry(m["id"], m.get("display_name")) for m in r.json().get("data", [])]

        if p.kind == "openrouter":
            r = await http.get("https://openrouter.ai/api/v1/models")
            r.raise_for_status()
            out = []
            for m in r.json().get("data", []):
                pricing = m.get("pricing") or {}
                out.append(
                    _entry(
                        m["id"],
                        m.get("name"),
                        context=m.get("context_length"),
                        price_in=_per_million(pricing.get("prompt")),
                        price_out=_per_million(pricing.get("completion")),
                    )
                )
            return out

        if p.kind == "vertex":
            return await asyncio.to_thread(_vertex_models, p)

        # OpenAI 형식: openai, xai, deepseek, ollama, lmstudio, openai_compatible
        base = (p.base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {"Authorization": f"Bearer {p.api_key}"} if p.api_key else {}
        r = await http.get(f"{base}/models", headers=headers)
        r.raise_for_status()
        return [_entry(m["id"]) for m in r.json().get("data", []) if m.get("id")]


def _per_million(per_token: Any) -> float | None:
    try:
        return round(float(per_token) * 1_000_000, 4)
    except (TypeError, ValueError):
        return None


def _vertex_models(p: ResolvedProvider) -> list[dict]:
    from google import genai

    from .vertex import resolve_vertex_auth

    client = genai.Client(vertexai=True, **resolve_vertex_auth(p).genai_kwargs())
    out = []
    for m in client.models.list():
        name = (m.name or "").split("/")[-1]
        if name:
            out.append(_entry(name, getattr(m, "display_name", None)))
    return out
