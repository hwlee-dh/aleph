"""등록된 제공자 인스턴스의 저장소.

제공자 인스턴스 = (종류, 주소, 키, 추가 값). `data/config/providers.json`에 둔다.
키는 이 파일 또는 환경변수에서 오고, API 응답으로는 절대 내보내지 않는다
(`public()`은 키 유무와 출처만 알려 준다).
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from pydantic import BaseModel, Field

from .kinds import KINDS

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")

# 처음 실행했을 때 목록에 미리 깔아 두는 제공자 (id = 종류 id)
_SEED = ["google", "anthropic", "vertex", "openai", "xai", "deepseek", "openrouter", "ollama"]


class ProviderConfig(BaseModel):
    id: str
    kind: str
    label: str = ""
    api_key: str = ""
    base_url: str = ""
    extra: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class ResolvedProvider(BaseModel):
    """키와 주소가 실제 값으로 풀린 제공자. 모델을 만들 때만 쓴다."""

    id: str
    kind: str
    label: str
    api_key: str | None
    base_url: str | None
    extra: dict[str, str]


class ProviderError(ValueError):
    pass


class ProviderStore:
    def __init__(self, config_dir: Path):
        self.path = config_dir / "providers.json"

    # --- 읽기/쓰기 ---

    def _load(self) -> list[ProviderConfig]:
        if not self.path.exists():
            items = [ProviderConfig(id=k, kind=k, label=KINDS[k].label) for k in _SEED]
            self._save(items)
            return items
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        return [ProviderConfig(**p) for p in raw if p.get("kind") in KINDS]

    def _save(self, items: list[ProviderConfig]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps([p.model_dump() for p in items], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list(self) -> list[ProviderConfig]:
        return self._load()

    def get(self, provider_id: str) -> ProviderConfig | None:
        return next((p for p in self._load() if p.id == provider_id), None)

    def upsert(self, config: ProviderConfig) -> ProviderConfig:
        if not _ID_RE.match(config.id):
            raise ProviderError("제공자 id는 영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.")
        if config.kind not in KINDS:
            raise ProviderError(f"알 수 없는 제공자 종류입니다: {config.kind}")
        items = self._load()
        existing = next((p for p in items if p.id == config.id), None)
        if existing and not config.api_key:
            config.api_key = existing.api_key
        for f in KINDS[config.kind].extra:
            if not f.secret:
                continue
            given = (config.extra.get(f.name) or "").strip()
            if given:
                if f.name == "credentials_json":
                    from .vertex import parse_service_account  # 저장 전에 형식을 확인한다

                    parse_service_account(given)
                config.extra[f.name] = given
            elif existing and existing.extra.get(f.name):
                config.extra[f.name] = existing.extra[f.name]  # 비워 보내면 저장된 값을 유지
        if not config.label:
            config.label = KINDS[config.kind].label
        if existing is None:
            items.append(config)
        else:
            items = [config if p.id == config.id else p for p in items]   # 목록에서의 자리는 그대로 둔다
        self._save(items)
        return config

    def clear_key(self, provider_id: str) -> None:
        items = self._load()
        for p in items:
            if p.id == provider_id:
                p.api_key = ""
                for f in KINDS[p.kind].extra:
                    if f.secret:
                        p.extra.pop(f.name, None)
        self._save(items)

    def delete(self, provider_id: str) -> bool:
        items = self._load()
        kept = [p for p in items if p.id != provider_id]
        if len(kept) == len(items):
            return False
        self._save(kept)
        return True

    # --- 값 풀기 ---

    def _key_and_source(self, config: ProviderConfig) -> tuple[str | None, str | None]:
        kind = KINDS[config.kind]
        if config.api_key:
            return config.api_key, "config"
        if kind.env_key and os.environ.get(kind.env_key):
            return os.environ[kind.env_key], "env"
        return None, None

    def _extra(self, config: ProviderConfig) -> dict[str, str]:
        kind = KINDS[config.kind]
        out: dict[str, str] = {}
        for f in kind.extra:
            value = config.extra.get(f.name) or (os.environ.get(f.env, "") if f.env else "")
            if value:
                out[f.name] = value
        return out

    def resolve(self, provider_id: str) -> ResolvedProvider:
        config = self.get(provider_id)
        if config is None:
            raise ProviderError(f"등록되지 않은 제공자입니다: {provider_id}")
        if not config.enabled:
            raise ProviderError(f"'{config.label or config.id}' 제공자가 꺼져 있습니다.")
        kind = KINDS[config.kind]
        key, _ = self._key_and_source(config)
        if kind.needs_key and not kind.key_optional and not key:
            raise ProviderError(f"제공자 '{config.label or config.id}'의 API 키가 없습니다.")
        base_url = config.base_url or kind.default_base_url
        if kind.id == "openai_compatible" and not base_url:
            raise ProviderError(f"제공자 '{config.label or config.id}'의 주소(base URL)가 없습니다.")
        return ResolvedProvider(
            id=config.id,
            kind=config.kind,
            label=config.label or kind.label,
            api_key=key,
            base_url=base_url,
            extra=self._extra(config),
        )

    def public(self, config: ProviderConfig) -> dict:
        """프론트로 내보내는 모양. 키 값은 없다."""
        kind = KINDS[config.kind]
        key, source = self._key_and_source(config)
        ready = bool(key) or not kind.needs_key or kind.key_optional
        extra = self._extra(config)
        if kind.id == "vertex":
            # 서비스 계정 키, API 키, 프로젝트 ID(+ gcloud 로그인) 중 하나는 있어야 한다
            ready = (
                bool(key)
                or bool(extra.get("credentials_json"))
                or bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"))
                or bool(extra.get("project"))
            )
        if kind.id == "openai_compatible":
            ready = bool(config.base_url)
        secret_names = {f.name for f in kind.extra if f.secret}
        return {
            "id": config.id,
            "kind": config.kind,
            "label": config.label or kind.label,
            "base_url": config.base_url,
            "effective_base_url": config.base_url or kind.default_base_url or "",
            "extra": {k: v for k, v in extra.items() if k not in secret_names},
            # 비밀값은 내용 대신 '저장돼 있는지'와 알아볼 수 있는 요약만 내보낸다
            "secrets": {name: _secret_summary(name, extra.get(name)) for name in secret_names},
            "enabled": config.enabled,
            "has_key": bool(key),
            "key_source": source,
            "ready": ready and config.enabled,
            "tested": kind.tested,
        }


def _secret_summary(name: str, value: str | None) -> dict:
    if not value:
        return {"set": False, "summary": ""}
    summary = ""
    if name == "credentials_json":
        try:
            info = json.loads(value)
            summary = f"{info.get('client_email', '')} · 프로젝트 {info.get('project_id', '?')}"
        except ValueError:
            pass
    return {"set": True, "summary": summary}


def split_model_ref(ref: str) -> tuple[str, str]:
    """'제공자id:모델이름' → (제공자id, 모델이름). 모델 이름 안의 콜론은 보존한다."""
    if not ref or ":" not in ref:
        raise ProviderError(f"모델 지정이 올바르지 않습니다: {ref!r} ('제공자:모델' 형식이어야 합니다)")
    provider_id, model_name = ref.split(":", 1)
    if not provider_id or not model_name:
        raise ProviderError(f"모델 지정이 올바르지 않습니다: {ref!r}")
    return provider_id, model_name
