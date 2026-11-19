"""테스트 공용 도구 — 실제 제공자 없이 대본대로 움직이는 가짜 모델."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel

from aleph.context import AppContext
from aleph.presets.store import Preset
from aleph.providers.factory import register_test_model
from aleph.settings import AppPaths
from aleph.tools.definitions import ToolDef

Step = dict | str  # {"tool": name, "args": {...}} 또는 최종 텍스트


def scripted_model(script: list[Step] | Callable[[list[ModelMessage]], Step], seen: list | None = None) -> FunctionModel:
    """모델 응답 수를 세어 대본의 다음 단계를 내놓는다. seen을 주면 모델이 받은 지침을 거기에 쌓는다."""

    def pick(messages: list[ModelMessage]) -> Step:
        if callable(script):
            return script(messages)
        done = sum(1 for m in messages if isinstance(m, ModelResponse))
        return script[min(done, len(script) - 1)]

    async def stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str | dict[int, DeltaToolCall]]:
        if seen is not None:
            seen.append(info.instructions or "")
        step = pick(messages)
        if isinstance(step, str):
            # 글자 조각으로 나눠 보내 스트리밍 경로를 태운다.
            for i in range(0, len(step), 7):
                yield step[i:i + 7]
        else:
            yield {0: DeltaToolCall(name=step["tool"], json_args=json.dumps(step.get("args", {}), ensure_ascii=False))}

    def plain(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        step = pick(messages)
        if isinstance(step, str):
            return ModelResponse(parts=[TextPart(content=step)])
        return ModelResponse(parts=[ToolCallPart(tool_name=step["tool"], args=step.get("args", {}))])

    return FunctionModel(plain, stream_function=stream)


def scripted(steps: list[Step]) -> Callable[[list[ModelMessage]], Step]:
    """대본을 '모델이 불린 횟수'로 진행한다. 실행이 여러 번 이어지는 테스트에서 쓴다 (대화 기억이 쌓여도 어긋나지 않는다)."""
    it = iter(steps)
    last: list[Step] = ["끝."]

    def pick(messages: list[ModelMessage]) -> Step:
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]

    return pick


@pytest.fixture
def ctx(tmp_path: Path) -> AppContext:
    return AppContext(AppPaths(data=tmp_path / "data"))


@pytest.fixture
def models():
    def register(ref: str, script, seen: list | None = None) -> None:
        register_test_model(ref, scripted_model(script, seen))

    return register


def test_preset(**kw) -> Preset:
    """집필·비평·요약 도구가 든 시험용 프리셋. 에이전트는 test:agent, 보조는 test:aux.

    집필과 비평은 가짜 모델 test:writer, test:critic을 쓰고, 요약은 모델을 비워 뒀으므로 보조 모델로 돈다.
    """
    base = dict(
        id="t",
        name="테스트",
        instruction="당신은 창작 에이전트다.",
        model="test:agent",
        auxiliary_model="test:aux",
        tools=[
            ToolDef(name="compose", label="집필", description="입력의 지시서로 본문을 쓴다.", model="test:writer", prompt="당신은 소설가다."),
            ToolDef(name="critique", label="비평", description="입력의 글을 비평한다.", model="test:critic", prompt="당신은 비평가다."),
            ToolDef(name="summarize", label="요약", description="입력의 글을 요약한다.", prompt="요약한다."),
        ],
    )
    return Preset(**{**base, **kw})


test_preset.__test__ = False  # pytest가 테스트로 줍지 않게


def basic_preset() -> Preset:
    """HTTP 테스트가 깔아 두고 쓰는 프리셋 (id는 `basic`). 모델은 비어 있다."""
    return test_preset(
        id="basic", name="기본", description="테스트용 프리셋.", model="", auxiliary_model="",
        tools=[
            ToolDef(name="compose", label="집필", description="입력의 지시서로 본문을 쓴다.", prompt="당신은 소설가다."),
            ToolDef(name="critique", label="비평", description="입력의 글을 비평한다.", prompt="당신은 비평가다."),
            ToolDef(name="summarize", label="요약", description="입력의 글을 요약한다.", prompt="요약한다."),
        ],
    )


@pytest.fixture
def work(ctx, models):
    """가짜 모델을 기본 모델로 두고 작업 하나를 만든다. 작업 id를 돌려준다."""
    models("test:aux", ["요약이다."])
    models("test:writer", ["바람이 불었다."])
    models("test:critic", ["고칠 것 없음."])

    def create(mode: str = "autonomous", preset: Preset | None = None, name: str = "작업", **state) -> str:
        # 프리셋의 칸(thinking, context_budget 등)을 적으면 프리셋에, 나머지는 작업의 상태에 들어간다.
        fields = {k: state.pop(k) for k in list(state) if k in Preset.model_fields}
        saved = ctx.presets.save((preset or test_preset()).model_copy(update=fields))
        sid = ctx.create_session(name, saved.id)["id"]
        ctx.set_state(sid, mode=mode, **state)
        return sid

    return create


def send(ctx: AppContext, sid: str, goal: str, tool: str = "", kind: str = "agent") -> str:
    return ctx.runs.start(sid, ctx.run_config(sid, goal=goal, tool=tool, kind=kind))


async def collect(ctx: AppContext, sid: str, after: int = 0) -> list[dict]:
    return [e async for e in ctx.runs.stream(sid, after)]


async def run(ctx: AppContext, sid: str, goal: str, answers: list[str] | None = None, **kw) -> list[dict]:
    """요청을 보내고 끝까지 돌린다. 질문·확인이 올 때마다 준비된 답을 차례로 준다."""
    send(ctx, sid, goal, **kw)
    events: list[dict] = []
    queue = list(answers or [])
    async for e in ctx.runs.stream(sid):
        events.append(e)
        if e["type"] == "user_input_required":
            assert queue, f"답이 준비되지 않은 확인: {e.get('kind')} {e.get('question')}"
            assert ctx.runs.respond(sid, e["event_id"], queue.pop(0))
    assert not queue, f"쓰이지 않은 답: {queue}"
    return events


def results(events: list[dict]) -> list[str]:
    return [e["result"] for e in events if e["type"] == "tool_result"]


def asks(events: list[dict]) -> list[dict]:
    return [e for e in events if e["type"] == "user_input_required"]

