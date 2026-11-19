"""사용자가 만든 도구를 돌린다.

도구는 언제나 '입력'을 읽고 결과를 '출력'에 쓴다. 도구가 보는 것은 자기 지시문과
입력뿐이다 (입력 안의 `@include`는 풀어서 넘긴다). 에이전트가 부르든 사용자가 직접
돌리든 같은 길을 탄다.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any

from pydantic_ai import RunContext, Tool

from ..agent.deps import APPROVE, REJECT, RunDeps
from ..workspace.documents import INPUT, OUTPUT, OUTPUT_DOC, Change
from .definitions import ToolDef

RESULT_LIMIT = 8_000     # 결과가 이보다 길면 에이전트에게는 앞부분만 돌려준다 (전체는 출력에 있다)
_PREVIEW_CHARS = 400

IO_NOTE = (
    "이 도구는 작업 공간의 '입력'에 적힌 글을 읽고, 결과를 '출력'에 씁니다 (전에 있던 출력은 덮입니다). "
    "도구는 대화를 보지 못하고 입력만 봅니다. 부르기 전에 필요한 것을 모두 입력에 적어 두세요. "
    "입력 안의 `@include:경로`는 그 문서의 내용으로 바뀌어 들어갑니다."
)


def describe(tool: ToolDef) -> str:
    """에이전트에게 보여줄 설명."""
    head = f"[{tool.title}] {tool.description.strip()}".strip()
    return f"{head}\n\n{IO_NOTE}"


async def run_user_tool(
    tool: ToolDef, deps: RunDeps, *, by: str, tool_call_id: str = "", confirm: bool = False,
    trial: dict | None = None,
) -> tuple[bool, str]:
    """도구를 한 번 돌린다. by: 'agent'(에이전트가 부름) | 'user'(사용자가 직접 돌림).

    trial을 주면 시험 실행이다: 출력을 건드리지 않고 결과를 기록에만 남긴다 (같은 입력으로 모델이나
    도구를 바꿔 견줄 때). trial = {"input": 예전 실행의 입력 전문 또는 None, "base_seq": 그 실행 번호, "model": 모델}

    반환: (결과가 나왔는지, 부른 쪽에 돌려줄 말)
    """
    docs = deps.docs
    if by == "agent" and deps.mode == "plan":
        return False, f"오류: {deps.blocked('output', [])}"
    if trial is not None and trial.get("input") is not None:
        raw = contents = str(trial["input"])      # 예전 실행에 실제로 들어갔던 글을 그대로 쓴다
    else:
        raw = docs.text(INPUT)
        contents = docs.resolve_includes(raw)
    if not raw.strip():
        return False, "오류: 입력이 비어 있습니다. 도구에 넘길 글을 '입력'에 먼저 써야 합니다."
    too_long = deps.over_input_limit(contents)
    if too_long:
        return False, f"오류: {too_long}"

    if by == "agent" and (deps.mode == "manual" or (deps.mode == "auto" and confirm)):
        answer = (
            await deps.hitl.ask(
                f"'{tool.title}' 도구를 돌리려 합니다.",
                [APPROVE, REJECT],
                kind="tool_confirm",
                extra={"tool": tool.name, "label": tool.title, "input": contents},
            )
        ).strip()
        if answer != APPROVE:
            note = "" if answer == REJECT else answer
            deps.rejected = True
            return False, (
                f"사용자가 '{tool.title}' 도구의 실행을 반려했습니다{f' — {note}' if note else ''}. "
                "도구를 돌리지 않았습니다. 사용자의 뜻을 반영해 입력을 고치거나, 무엇을 원하는지 물어보세요."
            )

    settings = deps.tool_settings(tool, (trial or {}).get("model") or "")
    model_ref = settings["model"]
    started = time.monotonic()

    def stream(delta: str) -> None:
        # 도구 안에서 모델이 쓰는 글을 화면으로 흘려보낸다 (기록에는 완성본만 남는다)
        deps.emit({"type": "tool_stream", "tool": tool.name, "tool_call_id": tool_call_id, "delta": delta})

    entry: dict[str, Any] = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "tool": tool.name,
        "label": tool.title,
        "by": by,
        "tool_call_id": tool_call_id,
        "run_id": deps.run_id,
        "model": model_ref,
        "input_raw": raw,
        "input": contents,
        "output": None,
        "usage": None,
        "duration_ms": None,
        "error": None,
        "trial": trial is not None,
        "base_seq": (trial or {}).get("base_seq"),
    }
    try:
        text, usage = await deps.llm.complete(
            model_ref,
            system=tool.prompt,
            prompt=contents,
            temperature=settings["temperature"],
            max_tokens=settings["max_tokens"],
            thinking=settings["thinking"],
            on_delta=stream,
        )
        entry["output"] = text
        entry["usage"] = usage
    except Exception as e:
        entry["error"] = f"{type(e).__name__}: {e}"
        # 실행 전체를 죽이지 않고 부른 쪽이 대처할 수 있게 오류를 결과로 돌려준다.
        from ..agent.loop import friendly_error   # 실행 루프와 같은 말로 알린다

        return False, f"오류: '{tool.title}' 도구를 돌리지 못했습니다. {friendly_error(e)}"
    finally:
        entry["duration_ms"] = int((time.monotonic() - started) * 1000)
        try:
            deps.sessions.append_tool_call_log(deps.session_id, entry)
        except Exception:
            pass  # 기록 실패가 도구 실행을 깨뜨리면 안 된다

    if not text.strip():
        return False, "(도구가 빈 결과를 돌려주었습니다. 출력은 그대로입니다.)"
    if trial is not None:
        return True, text   # 시험 실행: 출력에 쓰지 않는다

    docs.apply(
        Change("write", OUTPUT_DOC, content=text, old=docs.get(OUTPUT_DOC)),
        by=f"tool:{tool.name}",
        run_id=deps.run_id,
        origin={
            "tool_call_id": tool_call_id, "model": model_ref, "label": tool.title,
            **({"direct": True} if by == "user" else {}),
        },
    )
    deps.changed.append(OUTPUT)
    head = f"'{tool.title}' 도구의 결과가 출력에 들어갔습니다 ({len(text):,}자)."
    if len(text) <= RESULT_LIMIT:
        return True, f"{head}\n\n{text}"
    return True, (
        f"{head} 길어서 앞부분만 보입니다. 전체는 read('{OUTPUT}')로 읽으세요.\n\n"
        f"{text[:_PREVIEW_CHARS].rstrip()}…"
    )


async def run_tool_on(
    tool: ToolDef, deps: RunDeps, contents: str, *, target: str, tool_call_id: str = "",
) -> tuple[str, str]:
    """도구의 지시문과 값으로 글 하나를 돌린다. 입력과 출력 자리는 건드리지 않는다.

    여러 장면에 요약 도구를 나란히 돌릴 때 쓴다. target은 그 글이 온 곳('원고/s3')이고 기록에 남는다.
    반환: (결과 글, 오류의 말). 둘 중 하나는 비어 있다.
    """
    settings = deps.tool_settings(tool)
    started = time.monotonic()
    entry: dict[str, Any] = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "tool": tool.name, "label": tool.title, "by": "agent", "tool_call_id": tool_call_id, "run_id": deps.run_id,
        "model": settings["model"], "target": target, "input_raw": f"@include:{target}", "input": contents,
        "output": None, "usage": None, "duration_ms": None, "error": None, "trial": False, "base_seq": None,
    }
    try:
        text, usage = await deps.llm.complete(
            settings["model"], system=tool.prompt, prompt=contents,
            temperature=settings["temperature"], max_tokens=settings["max_tokens"], thinking=settings["thinking"],
        )
        entry["output"], entry["usage"] = text, usage
        return (text.strip(), "") if text.strip() else ("", "빈 결과가 돌아왔습니다")
    except Exception as e:
        entry["error"] = f"{type(e).__name__}: {e}"
        from ..agent.loop import friendly_error

        return "", friendly_error(e)
    finally:
        entry["duration_ms"] = int((time.monotonic() - started) * 1000)
        try:
            deps.sessions.append_tool_call_log(deps.session_id, entry)
        except Exception:
            pass


def build_tool(tool: ToolDef) -> Tool:
    async def run(ctx: RunContext[RunDeps], confirm: bool = False) -> str:
        _, message = await run_user_tool(
            tool, ctx.deps, by="agent", tool_call_id=ctx.tool_call_id or "", confirm=bool(confirm)
        )
        return message

    schema = {
        "type": "object",
        "properties": {
            "confirm": {
                "type": "boolean",
                "description": "true면 돌리기 전에 사용자에게 입력을 보여 주고 확인을 받습니다 (자동 모드에서만 의미가 있습니다).",
            }
        },
        "required": [],
        "additionalProperties": False,
    }
    return Tool.from_schema(run, name=tool.name, description=describe(tool), json_schema=schema, takes_ctx=True)


def build_user_tools(tools: list[ToolDef]) -> list[Tool]:
    return [build_tool(t) for t in tools if t.enabled and t.name]
