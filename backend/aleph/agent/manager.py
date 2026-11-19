"""실행 관리자 — 실행을 화면 연결과 분리해서 돌린다.

실행은 백그라운드 작업으로 돌고, 화면은 언제든 붙었다 떨어졌다 하면서 이벤트를
처음부터(또는 놓친 지점부터) 다시 받을 수 있다. 작업이 다르면 동시에 여러 실행이 돈다.
한 작업 안에서는 대화가 여럿이어도 한 번에 하나만 돈다 (입력과 출력 자리가 작업에 하나뿐이다).

실행에는 두 가지가 있다. 에이전트에게 요청을 보내는 것(kind=agent)과,
사용자가 도구를 직접 돌리는 것(kind=tool). 화면은 둘을 같은 흐름으로 받는다.
"""

from __future__ import annotations

import asyncio
import contextlib
import traceback
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from ..tools.definitions import find_tool
from ..workspace import undo
from .deps import RunDeps
from .hitl import HitlBroker
from .loop import RunConfig, execute_run, execute_tool_run

if TYPE_CHECKING:
    from ..context import AppContext

# 작업 기록(events.jsonl)에 남기는 이벤트. 글자 단위 조각(delta)은 남기지 않는다.
PERSISTED = {
    "run_started", "user_message", "text", "thinking", "tool_call", "tool_result",
    "user_input_required", "user_input_resolved", "compaction", "notice", "error", "done",
}


class RunBusyError(RuntimeError):
    pass


@dataclass
class ActiveRun:
    session_id: str
    run_id: str
    config: RunConfig
    events: list[dict] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    hitl: HitlBroker | None = None
    task: asyncio.Task | None = None
    finished: bool = False
    status: str = "running"
    steer: list[str] = field(default_factory=list)   # 실행 중에 사용자가 보낸 말 (아직 전하지 못한 것)


class RunManager:
    def __init__(self, ctx: AppContext):
        self.ctx = ctx
        self._runs: dict[str, ActiveRun] = {}
        self._held: set[str] = set()   # 실행은 아니지만 대화의 기억을 고치고 있는 작업 (손으로 돌린 압축)

    def close_interrupted(self) -> int:
        """서버가 꺼지는 바람에 끝을 맺지 못한 실행들을 맺는다. 엔진을 켤 때 한 번 부른다. 맺은 수를 돌려준다.

        실행은 서버 안에서 돌기 때문에, 창을 닫거나 컴퓨터가 꺼지면 기록이 `run_started`에서 끊긴 채 남는다.
        화면은 그 대화가 끝났는지 알 수 없다. 끝났다는 표시(`done`, status `interrupted`)를 붙여 준다.
        그 실행이 문서에 남긴 변경은 변경 기록에 있고, 에이전트의 기억에는 그 실행이 없다.
        """
        closed = 0
        sessions = self.ctx.sessions
        for item in sessions.list_sessions():
            sid = item["id"]
            for conversation in sessions.conversations(sid):
                cid = conversation["id"]
                open_run = None
                for e in sessions.read_events(sid, cid):
                    if e.get("type") == "run_started":
                        open_run = e.get("run_id")
                    elif e.get("type") == "done" and e.get("run_id") == open_run:
                        open_run = None
                if open_run:
                    sessions.append_event(sid, {
                        "type": "done", "status": "interrupted", "run_id": open_run, "conversation_id": cid,
                    }, cid)
                    closed += 1
        return closed

    # ------------------------------------------------------------ 조회

    def is_running(self, session_id: str) -> bool:
        """이 작업에서 지금 실행을 시작하거나 대화를 고치면 안 되는가. 실행 중이거나, 붙들려 있을 때다."""
        run = self._runs.get(session_id)
        return bool(run and not run.finished) or session_id in self._held

    @contextlib.contextmanager
    def hold(self, session_id: str):
        """실행이 아닌 일이 대화의 기억을 고치는 동안 작업을 붙들어 둔다. 그 사이에 실행이 시작되면 그 실행의 기억이 덮인다."""
        self._held.add(session_id)
        try:
            yield
        finally:
            self._held.discard(session_id)

    def status(self, session_id: str) -> dict:
        run = self._runs.get(session_id)
        if run is None:
            return {"running": False, "run_id": None, "conversation_id": None}
        return {
            "running": not run.finished,
            "run_id": run.run_id,
            "conversation_id": run.config.conversation,
            "status": run.status,
            "waiting_for_user": bool(run.hitl and run.hitl.waiting),
        }

    def running_sessions(self) -> list[str]:
        return [sid for sid, run in self._runs.items() if not run.finished]

    # ------------------------------------------------------------ 시작/중단

    def start(self, session_id: str, config: RunConfig) -> str:
        if self.is_running(session_id):
            raise RunBusyError("이 작업에서 이미 실행이 진행 중입니다.")
        run = ActiveRun(session_id=session_id, run_id=uuid4().hex, config=config)
        run.hitl = HitlBroker(lambda event: self._emit(run, event))
        self._runs[session_id] = run

        try:
            self.ctx.sessions.append_run(session_id, config.manifest(run.run_id))
            if config.trial is None:   # 시험 실행은 아무것도 바꾸지 않으므로 되돌릴 것이 없다
                # 이 실행을 나중에 통째로 되돌릴 수 있게, 직전의 상태를 적어 둔다.
                undo.remember(
                    self.ctx.sessions, session_id, run_id=run.run_id, kind=config.kind, goal=config.goal,
                    conversation=config.conversation,
                )
            # 이름이 없는 대화에는 첫 요청의 첫 줄을 이름으로 붙인다
            current = self.ctx.sessions.conversation(session_id, config.conversation)
            if current is not None and not current["name"] and config.goal.strip():
                first_line = config.goal.strip().splitlines()[0]
                self.ctx.sessions.update_conversation(session_id, config.conversation, name=first_line[:40])
        except Exception:
            traceback.print_exc()

        tool = find_tool(config.preset.tools, config.tool) if config.tool else None
        self._emit(run, {
            "type": "run_started",
            "kind": config.kind,
            **({"trial": True} if config.trial is not None else {}),
            "goal": config.goal,
            "mode": config.mode,
            "bypass_locks": config.bypass_locks,
            "agent_model": config.agent_model,
            "preset_name": config.preset.name,
        })
        message = {"type": "user_message", "text": config.goal}
        if tool is not None:
            message.update({"tool": tool.name, "tool_label": tool.title})
        self._emit(run, message)
        run.task = asyncio.create_task(self._drive(run), name=f"aleph-run-{run.run_id[:8]}")
        return run.run_id

    def stop(self, session_id: str) -> bool:
        run = self._runs.get(session_id)
        if run is None or run.finished or run.task is None:
            return False
        run.task.cancel()
        return True

    def steer(self, session_id: str, text: str) -> bool:
        """실행을 멈추지 않고 에이전트에게 말을 끼워 넣는다. 에이전트가 도는 중이 아니면 False."""
        run = self._runs.get(session_id)
        if run is None or run.finished or run.config.kind != "agent":
            return False
        self._emit(run, {"type": "user_message", "text": text, "steer": True})
        run.steer.append(text)
        return True

    def respond(self, session_id: str, event_id: str, response: str) -> bool:
        run = self._runs.get(session_id)
        if run is None or run.finished or run.hitl is None:
            return False
        # 답을 기록에 먼저 남기고(순서 보존) 기다리던 질문을 푼다.
        if event_id not in run.hitl._pending:
            return False
        self._emit(run, {"type": "user_message", "text": response, "in_reply_to": event_id})
        return run.hitl.resolve(event_id, response)

    async def shutdown(self) -> None:
        tasks = [r.task for r in self._runs.values() if r.task and not r.finished]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------ 구독

    async def stream(self, session_id: str, after: int = 0) -> AsyncIterator[dict]:
        """seq > after 인 이벤트를 순서대로 준다. 실행이 끝나면 스트림도 끝난다."""
        run = self._runs.get(session_id)
        if run is None:
            return
        queue: asyncio.Queue = asyncio.Queue()
        # 스냅숏과 구독 등록 사이에 await가 없으므로 이벤트를 놓치거나 겹치지 않는다.
        backlog = [e for e in run.events if e["seq"] > after]
        if run.finished:
            for e in backlog:
                yield e
            return
        run.subscribers.append(queue)
        try:
            for e in backlog:
                yield e
            while True:
                event = await queue.get()
                if event is None:
                    return
                yield event
        finally:
            if queue in run.subscribers:
                run.subscribers.remove(queue)

    # ------------------------------------------------------------ 내부

    def _emit(self, run: ActiveRun, event: dict) -> None:
        event = {
            **event,
            "seq": len(run.events) + 1,
            "run_id": run.run_id,
            "conversation_id": run.config.conversation,
            "timestamp": datetime.now().isoformat(timespec="milliseconds"),
        }
        run.events.append(event)
        if event["type"] in PERSISTED:
            try:
                self.ctx.sessions.append_event(run.session_id, event, run.config.conversation)
            except Exception:
                traceback.print_exc()
        for q in run.subscribers:
            q.put_nowait(event)

    def deps(self, run: ActiveRun) -> RunDeps:
        ctx = self.ctx
        config = run.config
        return RunDeps(
            session_id=run.session_id,
            sessions=ctx.sessions,
            docs=ctx.docs(run.session_id),
            hitl=run.hitl,  # type: ignore[arg-type]
            llm=ctx.llm,
            conversation=config.conversation,
            mode=config.mode,
            bypass_locks=config.bypass_locks,
            auxiliary_model=config.auxiliary_model,
            auxiliary_temperature=config.auxiliary_temperature,
            auxiliary_thinking=config.auxiliary_thinking,
            auxiliary_max_output_tokens=config.auxiliary_max_output_tokens,
            auxiliary_max_input_tokens=config.auxiliary_max_input_tokens,
            tools=config.preset.tools,
            image_model=config.image_model,
            emit=lambda event: self._emit(run, event),
            run_id=run.run_id,
            steer=run.steer,
        )

    async def _drive(self, run: ActiveRun) -> None:
        ctx = self.ctx
        config = run.config
        emit = lambda event: self._emit(run, event)  # noqa: E731
        try:
            deps = self.deps(run)
            if config.kind == "tool":
                tool = find_tool(config.preset.tools, config.tool)
                if tool is None:
                    raise ValueError(f"'{config.tool}' 도구를 찾을 수 없습니다.")
                run.status = await execute_tool_run(tool, run_id=run.run_id, deps=deps, emit=emit, trial=config.trial)
            else:
                run.status = await execute_run(
                    config,
                    run_id=run.run_id,
                    deps=deps,
                    providers=ctx.providers,
                    history_path=ctx.history_path(run.session_id, config.conversation),
                    emit=emit,
                )
        except asyncio.CancelledError:
            run.status = "stopped"
            emit({"type": "done", "status": "stopped", "run_id": run.run_id})
        except Exception as e:  # 실행 함수 바깥의 예상 못 한 오류
            traceback.print_exc()
            run.status = "error"
            emit({"type": "error", "error": f"실행 중에 문제가 생겼습니다. ({type(e).__name__}: {e})"})
            emit({"type": "done", "status": "error", "run_id": run.run_id})
        finally:
            run.finished = True
            for q in run.subscribers:
                q.put_nowait(None)
