"""실행 하나가 들고 다니는 맥락, 그리고 "이 변경을 해도 되는가"의 판단.

도구 함수는 전역 변수 대신 `ctx.deps`에서 작업 공간과 사용자 확인 창구를 꺼내 쓴다.
그래서 여러 작업이 동시에 돌아도 서로 섞이지 않는다.

에이전트와 도구가 문서를 바꾸려 할 때 거치는 관문은 둘이다.

  막힘      어느 모드에서도 안 되는 것: 수정 방지가 걸린 문서(권한 무시가 꺼져 있을 때),
            자리 밖의 경로, 계획 모드에서 자료가 아닌 것.
  확인      사용자에게 보여 주고 승인·반려를 받는 것. 모드가 정한다.
              수동   문서를 바꾸기 전에 항상
              자동   원고를 바꿀 때는 항상, 그 밖에는 에이전트가 청할 때
              자율   하지 않는다
              계획   하지 않는다 (자료만 고칠 수 있다)

사람이 직접 하는 변경은 이 관문을 거치지 않는다.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..workspace.documents import MANUSCRIPT, Change, DocWorkspace, josa, show_path, zone_of
from ..workspace.store import SessionStore
from .hitl import HitlBroker
from .llm import LlmService

APPROVE, REJECT = "승인", "반려"
CHARS_PER_TOKEN = 2.0   # 한국어 본문 기준의 거친 환산. 토큰 수를 실제로 잴 수 없을 때 쓴다


@dataclass
class RunDeps:
    session_id: str
    sessions: SessionStore
    docs: DocWorkspace
    hitl: HitlBroker
    llm: LlmService
    mode: str
    agent_model: str
    auxiliary_model: str
    conversation: str = "main"   # 이 실행이 도는 대화
    image_model: str = ""        # 그림을 만드는 모델. 비면 `generate_image` 도구가 없다
    bypass_locks: bool = False
    agent_temperature: float | None = None
    # 보조: 도구가 따로 정하지 않았을 때 쓰는 값
    auxiliary_temperature: float | None = None
    auxiliary_thinking: str = "default"
    auxiliary_max_output_tokens: int | None = None
    auxiliary_max_input_tokens: int | None = None
    tools: list = field(default_factory=list)   # 프리셋의 도구들 (ToolDef). 묶음 요약이 이름으로 찾는다
    emit: Callable[[dict], None] = lambda event: None
    # 맥락 압축이 만든 요약 캐시 (같은 구간을 두 번 요약하지 않도록)
    scratch: dict = field(default_factory=dict)
    run_id: str = ""
    # 지금 도는 도구 호출이 바꾼 경로들. 실행 루프가 tool_result에 실어 보내고 비운다.
    changed: list[str] = field(default_factory=list)
    # 지금 도는 도구 호출을 사용자가 반려했는가. 실행 루프가 tool_result에 실어 보내고 되돌린다.
    rejected: bool = False
    # 사용자가 실행 중에 보낸 말. 아직 에이전트에게 전하지 못한 것들 (실행 관리자와 같은 목록을 본다).
    steer: list[str] = field(default_factory=list)
    # 앱이 에이전트에게 알려야 하는 것 (만든 이미지가 어디에 저장됐는지 등). 사용자의 말과 같은 길로 전한다.
    notices: list[str] = field(default_factory=list)

    # ------------------------------------------------------------- 관문

    def blocked(self, zone: str | None, paths: list[str]) -> str:
        """이 변경이 막혀 있으면 그 이유. 아니면 빈 문자열."""
        if zone is None:
            return "문서는 '자료/' 아래에만 둘 수 있습니다. 원고는 장면 넣기로, 도구에 넘길 글은 '입력'에 씁니다."
        if self.mode == "plan" and zone != "material":
            return (
                "계획 모드에서는 자료만 고칠 수 있습니다. 도구를 돌리거나 원고·입력·출력을 바꾸지 않습니다. "
                "계획은 자료에 적습니다. 실행은 모드를 바꾼 뒤에 합니다."
            )
        if not self.bypass_locks:
            for p in paths:
                if p and self.docs.locked(p):
                    return f"{self.name_of(p)}에는 수정 방지가 걸려 있습니다. 에이전트는 고칠 수 없습니다."
        return ""

    def name_of(self, path: str) -> str:
        """사람이 알아볼 이름. 원고의 장면과 장은 경로(원고/s1) 대신 자리로 부른다."""
        shown = show_path(path)
        if zone_of(shown) != "manuscript":
            return f"'{shown}'"
        if shown == MANUSCRIPT:
            return "원고 전체"
        name = shown.split("/", 1)[1]
        try:
            if name.startswith("c"):
                ids = [c["id"] for c in self.docs.manuscript.overview()["chapters"]]
                return f"{ids.index(name) + 1}장"
            return self.docs.manuscript.label(name)
        except Exception:
            return f"'{shown}'"

    def needs_confirm(self, zone: str, confirm: bool) -> bool:
        if self.mode == "manual":
            return zone != "input"   # 입력은 도구를 돌리기 전 확인에서 통째로 보여 준다
        if self.mode == "auto":
            return zone == "manuscript" or confirm
        return False

    async def guard(
        self, *, zone: str | None, paths: list[str], payload: dict, confirm: bool = False, by: str = "agent",
        ask: bool = True,
    ) -> tuple[str | None, dict]:
        """변경 하나를 관문에 통과시킨다.

        반환: (막혔거나 반려됐으면 에이전트에게 돌려줄 말, 아니면 None) 과 기록에 덧붙일 값.
        """
        reason = self.blocked(zone, paths)
        if reason:
            return f"오류: {reason}", {}
        if not ask or not self.needs_confirm(zone or "", confirm):
            return None, {}
        proposal = self.docs.record_proposal(payload, by=by, run_id=self.run_id)
        answer = (
            await self.hitl.ask(
                payload.get("description", "문서를 바꾸려 합니다."),
                [APPROVE, REJECT],
                kind="proposal",
                extra={"proposal_id": proposal["id"], "by": by, **payload},
            )
        ).strip()
        if answer == APPROVE:
            self.docs.decide_proposal(proposal["id"], "accepted")
            return None, {"proposal_id": proposal["id"], "accepted_by": "user"}
        note = "" if answer == REJECT else answer
        self.docs.decide_proposal(proposal["id"], "rejected", note)
        self.rejected = True
        return (
            f"사용자가 이 변경을 반려했습니다{f' — {note}' if note else ''}. 아무것도 바뀌지 않았습니다. "
            "사용자의 뜻을 반영해 다시 하거나, 무엇을 원하는지 물어보세요."
        ), {}

    async def change_doc(
        self, change: Change, *, by: str = "agent", origin: dict | None = None, confirm: bool = False, ask: bool = True,
    ) -> tuple[bool, str]:
        """문서 하나를 바꾼다. (반영됐는지, 에이전트에게 돌려줄 말)"""
        zones = {zone_of(p) for p in change.paths}
        zone = None if None in zones else ("manuscript" if "manuscript" in zones else zone_of(change.paths[-1]))
        payload = {
            "action": change.action,
            "path": show_path(change.path),
            "dest": show_path(change.dest) if change.dest else None,
            "old": change.old,
            "new": change.content if change.action == "write" else None,
            "description": change.describe() if zone != "manuscript" else self._scene_words(change),
        }
        refusal, extra = await self.guard(zone=zone, paths=change.paths, payload=payload, confirm=confirm, by=by, ask=ask)
        if refusal:
            return False, refusal
        message = self.docs.apply(change, by=by, run_id=self.run_id, origin={**(origin or {}), **extra})
        if zone == "manuscript":
            self.note_manuscript_changed(show_path(change.path).split("/", 1)[1])
        else:
            self.changed.extend(show_path(p) for p in change.paths)
        if zone == "manuscript" and change.action == "write":
            scene_id = show_path(change.path).split("/", 1)[1]
            label = self.docs.manuscript.label(scene_id)
            message = f"{label}{josa(label, '을', '를')} 고쳤습니다 ({len(change.content):,}자)."
        if extra:
            message += " 사용자가 승인했습니다."
        return True, message

    def _scene_words(self, change: Change) -> str:
        try:
            label = self.docs.manuscript.label(show_path(change.path).split("/", 1)[1])
        except Exception:
            label = show_path(change.path)
        return f"원고 고치기: {label}"

    # ------------------------------------------------------------- 도구의 값

    def tool_settings(self, tool: Any, model: str = "") -> dict:
        """도구를 돌릴 때의 모델과 값. 도구가 비워 둔 칸은 보조의 값을 따른다."""
        return {
            "model": model or tool.model or self.auxiliary_model,
            "temperature": tool.temperature if tool.temperature is not None else self.auxiliary_temperature,
            "thinking": tool.thinking or self.auxiliary_thinking,
            "max_tokens": tool.max_tokens or self.auxiliary_max_output_tokens,
        }

    def over_input_limit(self, text: str) -> str:
        """도구에 넘길 글이 최대 입력을 넘으면 그 사실을 알리는 말. 아니면 빈 문자열. 토큰 수는 글자 수로 어림한다."""
        limit = self.auxiliary_max_input_tokens
        if not limit:
            return ""
        tokens = int(len(text) / CHARS_PER_TOKEN)
        if tokens <= limit:
            return ""
        return (
            f"입력이 약 {tokens:,}토큰({len(text):,}자)이라 최대 입력 {limit:,}토큰을 넘습니다. 도구를 돌리지 않았습니다. "
            "입력을 줄이거나(@include로 끌어오는 범위를 좁히거나) 나눠서 돌려야 합니다."
        )

    def note_trail(self, tool_call_id: str, trail: list[str]) -> None:
        """도구가 안에서 한 일(읽기 에이전트가 본 것)을 그 호출의 결과 이벤트에 실어 보내게 맡겨 둔다."""
        if tool_call_id and trail:
            self.scratch.setdefault("trails", {})[tool_call_id] = list(trail)

    def log_aux_call(self, purpose: str, usage: dict | None, started: float | None = None, **extra: Any) -> None:
        """보조 호출(대화 압축, 읽기 에이전트)을 도구 실행 기록에 남긴다. extra는 그 호출에 대해 더 적어 둘 것."""
        try:
            self.sessions.append_tool_call_log(self.session_id, {
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "tool": f"[{purpose}]",
                "run_id": self.run_id,
                "model": extra.pop("model", None) or self.auxiliary_model,
                "usage": usage,
                "duration_ms": int((time.monotonic() - started) * 1000) if started is not None else None,
                **extra,
            })
        except Exception:
            pass

    def note_manuscript_changed(self, *scene_ids: str) -> None:
        """원고가 바뀌었음을 알린다. 바뀐 장면을 알면 그 경로도 같이 (화면이 그 장면만 다시 읽도록)."""
        for path in [MANUSCRIPT, *(f"{MANUSCRIPT}/{i}" for i in scene_ids)]:
            if path not in self.changed:
                self.changed.append(path)
