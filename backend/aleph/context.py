"""앱 전체가 공유하는 객체 묶음.

지금은 사용자 한 명(이 컴퓨터의 주인)을 가정하고 하나만 만든다. 여러 사용자를
받게 되면 요청마다 그 사용자의 `AppContext`(= 그 사용자의 데이터 폴더)를 골라
주는 층을 `api/routes.py`의 `get_ctx`에 넣으면 된다. 그 아래 코드는 전역 상태를
쓰지 않으므로 손댈 필요가 없다.

모델 설정은 전부 프리셋에 있다. 앱 설정에 남는 것은 제공자(키)와 화면 설정(폰트)뿐이다.
"""

from __future__ import annotations

import json
import traceback
from pathlib import Path

from pydantic import BaseModel

from .agent.llm import LlmService
from .agent.loop import RunConfig
from .agent.manager import RunManager
from .fonts import FontStore
from .presets.store import Mode, Preset, PresetStore
from .providers.factory import is_test_model, split_model_ref
from .providers.store import ProviderError, ProviderStore
from .settings import AppPaths, default_paths
from .workspace.documents import DocWorkspace
from .workspace.store import SessionStore


class SessionState(BaseModel):
    """작업마다 따로 기억하는 것. 채팅창의 버튼들이 바꾼다. 모델은 여기에 없다 (프리셋에 있다)."""

    preset_id: str = ""
    mode: Mode = "auto"
    bypass_locks: bool = False   # 권한 무시
    auto_compact: bool = True    # 대화가 컨텍스트 한도를 넘으면 알아서 줄인다
    conversation: str = ""       # 지금 보고 있는 대화. 대화를 따로 적지 않은 요청은 여기로 간다


class SettingsStore:
    """화면 설정(폰트, 글자 크기 등). 모양은 화면이 정하고, 엔진은 내용을 보지 않고 맡아 둔다."""

    def __init__(self, config_dir: Path):
        self.path = config_dir / "appearance.json"

    def appearance(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def save_appearance(self, data: dict) -> dict:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return data


class AppContext:
    def __init__(self, paths: AppPaths | None = None):
        self.paths = paths or default_paths()
        self.paths.ensure()
        self.providers = ProviderStore(self.paths.config)
        self.settings = SettingsStore(self.paths.config)
        self.fonts = FontStore(self.paths.fonts)
        self.presets = PresetStore(self.paths.builtin_presets, self.paths.user_presets)
        self.sessions = SessionStore(self.paths.sessions)
        self.llm = LlmService(self.providers)
        self.runs = RunManager(self)
        try:
            self.runs.close_interrupted()
        except Exception:
            traceback.print_exc()   # 기록을 맺지 못해도 엔진은 켜져야 한다

    def docs(self, session_id: str) -> DocWorkspace:
        return DocWorkspace(self.sessions.path(session_id))

    def history_path(self, session_id: str, conversation: str = "main") -> Path:
        return self.sessions.history_path(session_id, conversation)

    # ------------------------------------------------------------- 작업의 상태

    def state(self, session_id: str) -> SessionState:
        meta = self.sessions.meta(session_id)
        try:
            state = SessionState(**{k: meta[k] for k in SessionState.model_fields if k in meta})
        except Exception:
            state = SessionState()
        if not state.preset_id or self.presets.get(state.preset_id) is None:
            state.preset_id = self.presets.first_id()
        ids = [c["id"] for c in self.sessions.conversations(session_id)]
        if state.conversation not in ids:   # 처음이거나, 보고 있던 대화가 지워졌다
            state.conversation = ids[-1]
        return state

    def set_state(self, session_id: str, **values) -> SessionState:
        current = self.state(session_id).model_dump()
        current.update({k: v for k, v in values.items() if k in current and v is not None})
        state = SessionState(**current)
        self.sessions.update_meta(session_id, **state.model_dump())
        return state

    def create_session(self, name: str, preset_id: str | None = None) -> dict:
        """작업을 만들고 프리셋의 시작 자료를 깐다."""
        created = self.sessions.create_session(name)
        preset = self.presets.get(preset_id) if preset_id else None
        if preset is None:
            preset = self.presets.get(self.presets.first_id())
        if preset is not None:
            # 프리셋이 시작 모드를 정해 뒀으면 그 모드로 연다. 만들 때 한 번뿐이다 (나중에 프리셋을 바꿔도 모드는 그대로).
            start = {"mode": preset.start_mode} if preset.start_mode else {}
            self.sessions.update_meta(created["id"], preset_id=preset.id, **start)
            self.docs(created["id"]).initialize(preset.starter, preset.starter_notes)
            created["preset_id"] = preset.id
        return created

    # ------------------------------------------------------------- 모델 고르기

    def usable(self, model_ref: str) -> bool:
        if not model_ref:
            return False
        if is_test_model(model_ref):
            return True
        try:
            provider_id, _ = split_model_ref(model_ref)
            self.providers.resolve(provider_id)
        except ProviderError:
            return False
        return True

    def effective_model(self, preset: Preset | None) -> str:
        """실제로 쓰일 에이전트 모델. 프리셋의 모델이 비었거나 쓸 수 없으면(제공자가 없음) 빈 문자열."""
        return preset.model if preset is not None and self.usable(preset.model) else ""

    def available(self, model_ref: str) -> dict[str, bool]:
        """이 모델에서 쓸 수 있는, 제공자가 실행하는 도구들. 모델을 만들 수 없으면(키 없음 등) 전부 false."""
        from .agent.native import supported_natives
        from .providers.factory import build_model

        try:
            model, _ = build_model(model_ref, self.providers)
        except Exception:
            return {"web_search": False, "web_fetch": False}
        return supported_natives(model)

    def run_config(
        self, session_id: str, *, goal: str = "", tool: str = "", kind: str = "agent", conversation: str = "",
    ) -> RunConfig:
        """작업의 상태와 프리셋을 모아 실행 하나의 설정을 만든다. 문제가 있으면 ValueError.

        conversation을 안 주면 지금 보고 있는 대화에서 돈다.
        """
        state = self.state(session_id)
        if conversation and self.sessions.conversation(session_id, conversation) is None:
            raise ValueError("그 대화를 찾을 수 없습니다.")
        preset = self.presets.get(state.preset_id)
        if preset is None:
            raise ValueError("프리셋이 없습니다. 에이전트 패널에서 프리셋을 먼저 만들어야 합니다.")
        agent_model = preset.model
        if not agent_model:
            raise ValueError("에이전트 모델이 정해지지 않았습니다. 채팅창에서 모델을 골라야 합니다.")
        auxiliary_model = preset.auxiliary_model or agent_model

        problems = []
        checks = [(agent_model, "에이전트 모델"), (auxiliary_model, "보조 모델")]
        if preset.image_model:
            checks.append((preset.image_model, "이미지 모델"))
        checks += [(t.model, f"도구 '{t.title}'의 모델") for t in preset.enabled_tools() if t.model]
        for ref, what in checks:
            if is_test_model(ref):
                continue
            try:
                self.providers.resolve(split_model_ref(ref)[0])
            except ProviderError as e:
                problems.append(f"{what}: {e}")
        if problems:
            raise ValueError(" / ".join(dict.fromkeys(problems)))

        return RunConfig(
            goal=goal,
            mode=state.mode,
            preset=preset,
            agent_model=agent_model,
            auxiliary_model=auxiliary_model,
            bypass_locks=state.bypass_locks,
            tool=tool,
            kind=kind,
            conversation=conversation or state.conversation,
            agent_temperature=preset.temperature,
            thinking=preset.thinking,
            max_output_tokens=preset.max_output_tokens,
            context_budget=preset.context_budget,
            auto_compact=state.auto_compact,
            auxiliary_temperature=preset.auxiliary_temperature,
            auxiliary_thinking=preset.auxiliary_thinking,
            auxiliary_max_output_tokens=preset.auxiliary_max_output_tokens,
            auxiliary_max_input_tokens=preset.auxiliary_max_input_tokens,
            image_model=preset.image_model,
        )
