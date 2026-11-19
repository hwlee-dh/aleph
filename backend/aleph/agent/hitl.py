"""사용자 확인 창구 — 실행 하나에 하나씩 생긴다.

에이전트가 질문을 던지거나(`request_user_input`) 모드에 따라 확인이 필요하면,
여기서 이벤트를 내보내고 사용자의 답이 올 때까지 기다린다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from uuid import uuid4

# 모델이 선택지에 끼워 넣곤 하는 "직접 입력" 류 항목은 뺀다 (입력창이 항상 있으므로).
_FREEFORM_BLOCKLIST = {
    "직접 입력", "자유 입력", "직접입력", "자유입력",
    "기타 사항", "기타사항", "기타 (직접 입력)", "기타(직접 입력)",
    "free input", "freeform", "free-form",
}


class HitlBroker:
    def __init__(self, emit: Callable[[dict], None]):
        self._emit = emit
        self._pending: dict[str, asyncio.Future[str]] = {}

    async def ask(
        self,
        question: str,
        options: list[str] | None = None,
        *,
        kind: str = "question",
        extra: dict | None = None,
    ) -> str:
        """질문을 내보내고 답을 기다린다. kind: 'question' | 'approval'.

        extra는 화면이 질문을 더 잘 그리도록 함께 실어 보내는 값이다
        (승인 요청이면 어떤 도구를 어떤 인자로 부르려는지).
        """
        option_list = [
            o.strip() for o in (options or [])
            if isinstance(o, str) and o.strip() and o.strip().lower() not in _FREEFORM_BLOCKLIST
        ]
        event_id = uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[event_id] = future
        try:
            self._emit({
                "type": "user_input_required",
                "event_id": event_id,
                "kind": kind,
                "question": question,
                "options": option_list,
                **(extra or {}),
            })
            return await future
        finally:
            # 답이 왔든 실행이 취소됐든 항상 정리한다 — 죽은 질문에 답이 들어가지 않도록.
            self._pending.pop(event_id, None)

    def resolve(self, event_id: str, response: str) -> bool:
        future = self._pending.get(event_id)
        if future is None or future.done():
            return False
        future.set_result(response)
        self._emit({"type": "user_input_resolved", "event_id": event_id})
        return True

    @property
    def waiting(self) -> bool:
        return bool(self._pending)
