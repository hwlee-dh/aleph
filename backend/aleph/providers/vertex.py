"""Vertex AI 인증 — 세 가지 방식을 한 곳에서 고른다.

우선순위:
  1. 서비스 계정 키(JSON) — Google Cloud 콘솔에서 내려받는 그 파일의 내용.
     설정 화면에 붙여 넣거나 파일을 골라 넣는다. `.env`의
     GOOGLE_APPLICATION_CREDENTIALS에 파일 경로를 적어 둔 경우도 여기에 해당한다.
  2. API 키 — Vertex AI 익스프레스 모드의 키.
  3. 이 컴퓨터의 기본 자격 증명 — `gcloud auth application-default login`으로 로그인해 둔 계정.

프로젝트 ID는 따로 적지 않으면 키 안의 값을 쓴다.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .store import ProviderError, ResolvedProvider

_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def parse_service_account(text: str) -> dict:
    """서비스 계정 키 JSON인지 확인하고 dict로 돌려준다."""
    try:
        info = json.loads(text)
    except ValueError as e:
        raise ProviderError(f"서비스 계정 키를 읽지 못했습니다. JSON 형식이 아닙니다: {e}") from e
    if not isinstance(info, dict) or info.get("type") != "service_account":
        raise ProviderError('서비스 계정 키가 아닙니다 ("type": "service_account"가 있어야 합니다).')
    missing = [k for k in ("private_key", "client_email") if not info.get(k)]
    if missing:
        raise ProviderError(f"서비스 계정 키에 빠진 항목이 있습니다: {', '.join(missing)}")
    return info


@dataclass
class VertexAuth:
    credentials: Any = None
    api_key: str | None = None
    project: str | None = None
    location: str = "global"

    def genai_kwargs(self) -> dict:
        """google-genai / Pydantic AI의 Google Cloud 제공자에 넘길 인자."""
        if self.api_key and self.credentials is None:
            return {"api_key": self.api_key}
        kwargs: dict[str, Any] = {"project": self.project, "location": self.location}
        if self.credentials is not None:
            kwargs["credentials"] = self.credentials
        return kwargs


def _service_account_text(p: ResolvedProvider) -> str | None:
    stored = (p.extra.get("credentials_json") or "").strip()
    if stored:
        return stored
    env_path = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or "").strip().strip('"')
    if not env_path:
        return None
    path = Path(env_path).expanduser()
    if not path.is_file():
        raise ProviderError(f"GOOGLE_APPLICATION_CREDENTIALS가 가리키는 파일을 찾을 수 없습니다: {path}")
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        raise ProviderError(f"서비스 계정 키 파일을 읽지 못했습니다: {e}") from e


def resolve_vertex_auth(p: ResolvedProvider) -> VertexAuth:
    location = p.extra.get("location") or "global"
    project = p.extra.get("project") or None

    text = _service_account_text(p)
    if text:
        info = parse_service_account(text)
        from google.oauth2 import service_account

        try:
            credentials = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
        except Exception as e:
            raise ProviderError(f"서비스 계정 키가 올바르지 않습니다: {e}") from e
        return VertexAuth(credentials=credentials, project=project or info.get("project_id"), location=location)

    if p.api_key:
        return VertexAuth(api_key=p.api_key, project=project, location=location)

    if not project:
        raise ProviderError("Vertex AI는 서비스 계정 키, API 키, 프로젝트 ID 중 하나가 필요합니다.")
    return VertexAuth(project=project, location=location)
