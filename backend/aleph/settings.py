"""경로와 환경 설정.

데이터가 어디 놓이는지는 이 모듈만 안다. 나중에 여러 사용자를 받게 되면
`AppPaths`를 사용자별로 만들어 주는 것으로 분리할 수 있다.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


def _version() -> tuple[str, str]:
    """앱의 버전 번호와 그 번호를 올린 날. 적는 곳은 backend/pyproject.toml 하나다."""
    try:
        data = tomllib.loads((BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", ""
    version = str(data.get("project", {}).get("version", ""))
    date = str(data.get("tool", {}).get("aleph", {}).get("date", ""))
    return version, date


VERSION, VERSION_DATE = _version()

load_dotenv(REPO_DIR / ".env")


@dataclass(frozen=True)
class AppPaths:
    data: Path

    @property
    def sessions(self) -> Path:
        return self.data / "sessions"

    @property
    def config(self) -> Path:
        return self.data / "config"

    @property
    def user_presets(self) -> Path:
        return self.data / "presets"

    @property
    def fonts(self) -> Path:
        return self.data / "fonts"

    @property
    def builtin_presets(self) -> Path:
        return BACKEND_DIR / "presets"

    @property
    def frontend_dist(self) -> Path:
        return REPO_DIR / "frontend" / "dist"

    def ensure(self) -> None:
        for p in (self.sessions, self.config, self.user_presets):
            p.mkdir(parents=True, exist_ok=True)


def default_paths() -> AppPaths:
    raw = os.environ.get("ALEPH_DATA_DIR")
    return AppPaths(data=Path(raw).resolve() if raw else REPO_DIR / "data")
