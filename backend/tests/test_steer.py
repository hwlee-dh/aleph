"""실행 중에 말 걸기 — 멈추지 않고 에이전트에게 말을 끼워 넣는다."""

from __future__ import annotations

import asyncio
import json

from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.function import DeltaToolCall, FunctionModel

from aleph.providers.factory import register_test_model
from tests.conftest import send


def prompts(messages) -> list[str]:
    return [p.content for m in messages if isinstance(m, ModelRequest) for p in m.parts if isinstance(p, UserPromptPart)]


def fake_agent(steps: list, seen: list[list[str]], gate: asyncio.Event | None = None) -> FunctionModel:
    """대본대로 움직이되, 모델이 불릴 때마다 그때까지 받은 사용자 말을 적어 둔다. gate가 있으면 마지막 말을 하기 전에 기다린다."""
    it = iter(steps)

    async def stream(messages, info):
        seen.append(prompts(messages))
        step = next(it, "끝.")
        if isinstance(step, str):
            if gate is not None and not gate.is_set():
                await gate.wait()
            yield step
        else:
            yield {0: DeltaToolCall(name=step["tool"], json_args=json.dumps(step.get("args", {}), ensure_ascii=False))}

    def plain(messages, info):
        return ModelResponse(parts=[TextPart(content="끝.")])

    return FunctionModel(plain, stream_function=stream)


async def drive(ctx, sid: str, on_event) -> list[dict]:
    events: list[dict] = []
    async for e in ctx.runs.stream(sid):
        events.append(e)
        await on_event(e)
    return events


async def test_steer_during_a_tool_call(ctx, work):
    seen: list[list[str]] = []
    register_test_model("test:agent", fake_agent([
        {"tool": "ask_user", "args": {"question": "누구의 시점으로 쓸까요?"}},
        {"tool": "write", "args": {"path": "자료/계획", "content": "아버지 시점으로 쓴다"}},
        "계획을 적었다.",
    ], seen))
    sid = work("auto")
    assert ctx.runs.steer(sid, "지금은 아무도 안 돈다") is False               # 실행 중이 아니면 받지 않는다
    send(ctx, sid, "첫 장면을 준비해줘")

    async def on_event(e):
        if e["type"] == "user_input_required":
            # 질문을 기다리는 동안 다른 말을 끼워 넣는다. 질문의 답이 아니라 따로 전달된다.
            assert ctx.runs.steer(sid, "그리고 문장은 짧게 써줘") is True
            assert ctx.runs.respond(sid, e["event_id"], "아버지")

    events = await drive(ctx, sid, on_event)
    assert events[-1]["status"] == "completed"
    steered = [e for e in events if e["type"] == "user_message" and e.get("steer")]
    assert [e["text"] for e in steered] == ["그리고 문장은 짧게 써줘"]
    # 묻기 도구가 끝난 직후의 모델 호출에 그 말이 들어갔다
    assert seen[0] == ["첫 장면을 준비해줘"]
    assert seen[1][-1] == "[사용자가 실행 중에 보낸 말입니다. 지금 하던 일에 반영하십시오.]\n그리고 문장은 짧게 써줘"
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["ask_user", "write"]
    assert sum(1 for e in events if e["type"] == "done") == 1


async def test_steer_when_the_agent_was_about_to_finish(ctx, work):
    seen: list[list[str]] = []
    gate = asyncio.Event()
    register_test_model("test:agent", fake_agent(["다 했다.", {"tool": "write", "args": {"path": "자료/메모", "content": "추가 요청 반영"}}, "반영했다."], seen, gate))
    sid = work("autonomous")
    send(ctx, sid, "정리해줘")

    async def on_event(e):
        if e["type"] == "user_message" and not e.get("steer"):
            await asyncio.sleep(0.05)                                         # 에이전트가 마지막 말을 하려는 참
            assert ctx.runs.steer(sid, "아, 메모도 하나 남겨줘")
            gate.set()

    events = await drive(ctx, sid, on_event)
    assert events[-1]["status"] == "completed" and sum(1 for e in events if e["type"] == "done") == 1   # 같은 실행 안에서 이어 간다
    texts = [e["text"] for e in events if e["type"] == "text"]
    assert texts == ["다 했다.", "반영했다."]
    assert seen[1][-1].endswith("아, 메모도 하나 남겨줘") and seen[1][0] == "정리해줘"
    assert ctx.docs(sid).get("자료/메모.md") == "추가 요청 반영"
    assert events[-1]["usage"]["prompt_tokens"] > 0 and events[-1]["total_tool_calls"] == 1


async def test_steer_over_http(ctx, work):
    import httpx

    from aleph.app import create_app

    seen: list[list[str]] = []
    gate = asyncio.Event()
    register_test_model("test:agent", fake_agent(["다 했다.", "알겠다."], seen, gate))
    sid = work("autonomous")
    app = create_app(ctx.paths)
    app.state.ctx = ctx
    base = f"/api/sessions/{sid}"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        assert (await http.post(f"{base}/steer", json={"text": "안 도는 중"})).status_code == 409
        assert (await http.post(f"{base}/runs", json={"goal": "정리해줘"})).status_code == 200
        await asyncio.sleep(0.05)
        assert (await http.post(f"{base}/steer", json={"text": "  "})).status_code == 400
        assert (await http.post(f"{base}/steer", json={"text": "한 가지 더"})).json() == {"status": "queued"}
        gate.set()
        stream = (await http.get(f"{base}/stream")).text
    assert '"steer": true' in stream and '"status": "completed"' in stream
    assert seen[-1][-1].endswith("한 가지 더")
