"""대화 압축 — 대화가 길어지면 앞부분을 줄인다.

모델에 요청을 보내기 직전마다 대화의 크기를 재고, 컨텍스트 한도를 넘으면 두 단계로 줄인다.

  1. 오래된 도구 결과를 비운다. 읽어 온 장면과 자료가 대화의 대부분이고, 그것은 다시 읽으면 된다.
     모델을 부르지 않고 대화의 흐름은 그대로 남는다. 이것으로 충분히 내려가면 여기서 끝낸다.
  2. 그래도 넘으면 앞부분을 보조 모델로 요약한다. 최근 구간은 원문 그대로 남기고,
     요약으로 바뀌는 구간에서 사용자가 한 말도 요약하지 않고 그대로 남긴다.

문서 목록과 노트는 대화가 아니라 지침에 매번 새로 들어가므로 여기서 다루지 않는다.
압축은 엔진의 일이고 프리셋의 도구가 아니다. 지시문도 여기에 있다.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import replace

from pydantic_ai import RunContext
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from .deps import CHARS_PER_TOKEN, RunDeps

_KEEP_RATIO = 0.35          # 압축한 뒤에 원문으로 남길 최근 구간 (한도에 대한 비율)
_CLEAR_TARGET = 0.7         # 도구 결과를 비워서 한도의 이만큼 아래로 내려가면 요약하지 않는다
_CLEAR_MIN = 400            # 이보다 짧은 도구 결과는 비우지 않는다
_PART_LIMIT = 1500          # 요약에 넘길 때 도구 결과 하나의 길이
_RENDER_FLOOR = 150_000     # 요약에 넘기는 글의 상한 (한도가 크면 그에 맞춰 늘어난다)
_USER_PART_LIMIT = 6_000    # 원문으로 남기는 사용자의 말 하나
_USER_KEEP_CHARS = 30_000   # 원문으로 남기는 사용자의 말 전부
_FILE_CHARS = 3_000         # 대화에 든 파일(이미지, PDF) 하나를 글자 수로 친 값. 바이트 수로 세면 터무니없이 커진다
_REGROW_CHARS = 8_000       # 줄인 뒤에 대화가 적어도 이만큼(또는 10%) 늘어야 다시 줄인다

CLEARED = "(오래된 도구 결과라 비웠습니다. 필요하면 다시 읽으세요.)"
_NOTE_OPEN = "<previous_work_summary>"
_NOTE_RE = re.compile(r"<previous_work_summary>\n(?:[^\n]*\n\n)?(.*?)\n</previous_work_summary>", re.DOTALL)
_USER_RE = re.compile(r"<user_message>\n(.*?)\n</user_message>", re.DOTALL)
_USER_CLOSE, _USER_CLOSE_SAFE = "</user_message>", "&lt;/user_message&gt;"   # 사용자의 말에 닫는 표가 들어 있으면 바꿔 적는다

SUMMARY_SYSTEM = """당신은 긴 창작 작업 세션의 기록을 인수인계용으로 요약한다.
이 요약은 같은 작업을 이어받을 에이전트가 읽는다. 원문 기록은 사라지므로,
이어서 일하는 데 필요한 것은 빠짐없이 남긴다.

다음 순서로 쓴다.
1. 사용자가 요청한 것과 지금까지 합의·결정된 사항
2. 지금까지 한 일 (어떤 자료·원고가 만들어지고 고쳐졌는지, 경로와 함께)
3. 사용자가 준 피드백과 선호
4. 진행 중이던 일과 다음에 할 일

[앞선 요약]이 있으면 그것은 더 앞의 기록을 이미 요약한 글이다. 그 내용을 잃지 않게 새 요약에 합쳐 쓴다.
사용자가 한 말은 요약과 따로 원문 그대로 남는다. 길게 옮겨 적지 말고, 무엇을 요청했고 무엇이 정해졌는지만 적는다.
작업 공간에 저장된 내용(자료, 원고)은 에이전트가 다시 읽을 수 있으니 본문을 옮겨 적지 말고 무엇이 어디에 있는지만 적는다.
군더더기 없이 사실만 쓴다."""

Summarize = Callable[[str], Awaitable[str]]


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        return "\n".join(c for c in content if isinstance(c, str))
    return str(content)


def _cut(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f" …(이하 {len(text) - limit:,}자 생략)"


def _is_note(part: object) -> bool:
    return isinstance(part, UserPromptPart) and _text(part.content).startswith(_NOTE_OPEN)


def render_messages(messages: list[ModelMessage], limit: int = _RENDER_FLOOR) -> str:
    """요약할 구간을 글로 편다. 앞선 요약(을 담은 말)은 넣지 않는다. 그것은 따로 통째로 넘긴다."""
    lines: list[str] = []
    for msg in messages:
        if isinstance(msg, ModelRequest):
            for p in msg.parts:
                if _is_note(p):
                    continue
                if isinstance(p, UserPromptPart):
                    lines.append(f"[사용자] {_cut(_text(p.content), 4000)}")
                elif isinstance(p, ToolReturnPart):
                    lines.append(f"[도구 결과: {p.tool_name}] {_cut(_text(p.content), _PART_LIMIT)}")
                elif isinstance(p, RetryPromptPart):
                    lines.append(f"[도구 오류: {p.tool_name}] {_cut(_text(p.content), 500)}")
        elif isinstance(msg, ModelResponse):
            for p in msg.parts:
                if isinstance(p, TextPart) and p.content.strip():
                    lines.append(f"[에이전트] {_cut(p.content, 3000)}")
                elif isinstance(p, ToolCallPart):
                    lines.append(f"[도구 호출: {p.tool_name}] {_cut(_text(p.args), _PART_LIMIT)}")
    text = "\n".join(lines)
    if len(text) > limit:
        half = limit // 2
        text = text[:half] + "\n…(중간 생략)…\n" + text[-half:]
    return text


def _is_file(item: object) -> bool:
    """글이 아닌 것(이미지, PDF)."""
    return not isinstance(item, (str, int, float, bool, dict, type(None)))


def _size(content: object) -> int:
    """대화의 한 조각을 글자 수로 친 크기."""
    if isinstance(content, str):
        return len(content)
    if isinstance(content, (list, tuple)):
        return sum(_FILE_CHARS if _is_file(c) else len(c if isinstance(c, str) else str(c)) for c in content)
    return _FILE_CHARS if _is_file(content) else len(str(content))


def _chars(messages: list[ModelMessage]) -> int:
    total = 0
    for msg in messages:
        for p in msg.parts:
            content = getattr(p, "content", None)
            if content is None:
                content = getattr(p, "args", "")
            total += _size(content)
    return total


def _tokens_per_char(tokens: int, messages: list[ModelMessage]) -> float:
    """이 대화에서 글자 하나가 토큰 몇 개인가. 실측한 크기에서 거꾸로 셈한다.

    한국어는 모델에 따라 글자 하나가 토큰 하나를 넘기도 한다. 지침과 도구 설명처럼 대화 밖에서 들어가는 것도
    이 값에 섞여 들어가서 크게 나오는데, 그러면 남길 구간이 작아질 뿐이라 안전한 쪽이다.
    """
    return min(4.0, max(1 / CHARS_PER_TOKEN / 2, tokens / max(1, _chars(messages))))


def estimate_tokens(messages: list[ModelMessage]) -> tuple[int, ModelResponse | None]:
    """(대화의 크기 추정, 실측의 근거가 된 응답). 마지막 응답의 실측 사용량에 그 뒤 분량을 더한다."""
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, ModelResponse) and msg.usage and (msg.usage.input_tokens or 0) > 0:
            measured = (msg.usage.input_tokens or 0) + (msg.usage.output_tokens or 0)
            return int(measured + _chars(messages[i + 1:]) / CHARS_PER_TOKEN), msg
    return int(_chars(messages) / CHARS_PER_TOKEN), None


def _find_cut(messages: list[ModelMessage], keep_chars: float) -> int | None:
    """꼬리로 남길 구간의 시작 위치. 반드시 모델 응답에서 시작해야 도구 호출/결과 짝이 안 깨진다."""
    budget_chars = keep_chars
    acc = 0.0
    cut = None
    for i in range(len(messages) - 1, 0, -1):
        acc += _chars([messages[i]])
        if isinstance(messages[i], ModelResponse):
            cut = i
            if acc >= budget_chars:
                break
    if cut is None or cut < 2:
        return None  # 줄일 앞부분이 없다
    return cut


def clear_tool_results(messages: list[ModelMessage]) -> tuple[list[ModelMessage], int, int]:
    """긴 도구 결과를 한 줄로 바꾼다. (새 목록, 비운 결과의 수, 줄어든 글자 수). 원래 목록은 그대로 둔다."""
    out: list[ModelMessage] = []
    count = saved = 0
    for msg in messages:
        if not isinstance(msg, ModelRequest):
            out.append(msg)
            continue
        parts = []
        touched = False
        for p in msg.parts:
            if isinstance(p, ToolReturnPart):
                size = len(_text(p.content))
                if size >= _CLEAR_MIN and p.content != CLEARED:
                    p = replace(p, content=CLEARED)
                    count += 1
                    saved += size - len(CLEARED)
                    touched = True
            parts.append(p)
        out.append(replace(msg, parts=parts) if touched else msg)   # 안 바뀐 것은 그 객체 그대로 둔다
    return out, count, saved


def _user_words(head: list[ModelMessage]) -> tuple[str, list[str]]:
    """(앞선 요약, 사용자가 한 말들). 앞선 압축이 남긴 말들도 이어서 가져온다.

    지금 하고 있는 요청도 다른 말과 똑같이 남긴다. 따로 빼 두면 다음 압축에서 잃는다.
    """
    previous = ""
    words: list[str] = []
    for msg in head:
        if not isinstance(msg, ModelRequest):
            continue
        for p in msg.parts:
            if not isinstance(p, UserPromptPart):
                continue
            if isinstance(p.content, (list, tuple)) and any(_is_file(c) for c in p.content):
                continue   # 사용자의 말이 아니라 도구가 붙여 준 파일이다 (view_file)
            text = _text(p.content).strip()
            if text.startswith(_NOTE_OPEN):
                found = _NOTE_RE.search(text)
                previous = found.group(1).strip() if found else previous
                words += [w.strip().replace(_USER_CLOSE_SAFE, _USER_CLOSE) for w in _USER_RE.findall(text)]
            elif text:
                words.append(_cut(text, _USER_PART_LIMIT))
    return previous, words


def _note(summary: str, words: list[str], goal: str) -> str:
    kept: list[str] = []
    size = 0
    for w in reversed(words):   # 최근 것부터 남긴다
        if kept and size + len(w) > _USER_KEEP_CHARS:
            break
        kept.append(w)
        size += len(w)
    kept.reverse()
    note = (
        f"{_NOTE_OPEN}\n"
        "대화가 길어져 앞부분을 요약으로 대체했다. 세부 내용은 작업 공간을 다시 읽어 확인한다.\n\n"
        f"{summary}\n"
        "</previous_work_summary>"
    )
    if kept:
        dropped = len(words) - len(kept)
        head = "요약으로 바뀐 구간에서 사용자가 한 말이다. 원문 그대로이고 오래된 것부터 적혀 있다."
        if dropped:
            head += f" (더 앞의 {dropped}건은 길어서 뺐다. 요약에 들어 있다.)"
        blocks = "\n".join(f"<user_message>\n{w.replace(_USER_CLOSE, _USER_CLOSE_SAFE)}\n</user_message>" for w in kept)
        note += f"\n\n<user_messages>\n{head}\n{blocks}\n</user_messages>"
    if goal.strip():
        # 이 글은 다음 요청 때도 대화에 남아 있다. 그때 읽어도 틀리지 않게 "그때 하던 요청"이라고 적는다.
        note += f"\n\n<request_in_progress>\n대화를 요약으로 바꿀 때 하고 있던 요청이다.\n{goal.strip()}\n</request_in_progress>"
    return note


async def compact_messages(
    messages: list[ModelMessage], budget: int, *, summarize: Summarize, goal: str = "", force: bool = False,
) -> tuple[list[ModelMessage], dict | None]:
    """대화를 줄인다. (새 대화, 무슨 일이 있었는지). 줄일 것이 없으면 (원래 대화, None).

    force면 한도를 넘지 않았어도 요약까지 한다 (사용자가 `지금 압축`을 눌렀을 때).
    summarize는 요약할 글을 받아 요약을 돌려준다. 실패하면 예외를 던지거나 빈 글을 돌려주면 된다.
    """
    before, _ = estimate_tokens(messages)
    if len(messages) < 4 or (not force and (budget <= 0 or before < budget)):
        return messages, None
    base = min(budget, before) if budget > 0 else before
    per_char = _tokens_per_char(before, messages)
    cut = _find_cut(messages, base * _KEEP_RATIO / per_char)
    if cut is None:
        return messages, None
    head, tail = messages[:cut], messages[cut:]

    cleared_head, cleared, saved = clear_tool_results(head)
    after_clear = int(before - saved * per_char)
    if cleared and not force and after_clear <= budget * _CLEAR_TARGET:
        return [*cleared_head, *tail], {
            "kind": "cleared", "cleared_results": cleared, "dropped_messages": 0, "kept_messages": len(messages),
            "tokens_before": before, "tokens_after": after_clear, "summary": "",
        }

    previous, words = _user_words(head)
    rendered = render_messages(head, max(_RENDER_FLOOR, int(base / per_char)))
    prompt = (f"[앞선 요약]\n{previous}\n\n[그 뒤의 기록]\n" if previous else "") + rendered
    error = ""
    try:
        summary = (await summarize(prompt)).strip()
    except Exception as e:
        summary, error = "", f"{type(e).__name__}: {e}"
    failed = not summary
    if failed:
        calls = [
            f"- {p.tool_name}"
            for m in head if isinstance(m, ModelResponse)
            for p in m.parts if isinstance(p, ToolCallPart)
        ]
        summary = (previous + "\n\n" if previous else "") + (
            "이 뒤의 구간은 요약을 만들지 못했다. 그 구간에서 부른 도구:\n" + "\n".join(calls[-80:])
        )

    compacted = [ModelRequest(parts=[UserPromptPart(content=_note(summary, words, goal))]), *tail]
    return compacted, {
        "kind": "summary", "cleared_results": 0, "dropped_messages": len(head), "kept_messages": len(tail),
        "tokens_before": before,
        # 압축 전 실측값에 분량 비율을 곱해 같은 척도로 어림한다
        "tokens_after": int(before * _chars(compacted) / max(1, _chars(messages))),
        "summary": summary,
        **({"failed": True, "error": error or "빈 요약이 돌아왔다"} if failed else {}),
    }


def summarizer(deps: RunDeps) -> Summarize:
    """보조 모델로 요약하는 함수. 사용량을 기록에 남긴다."""
    async def run(prompt: str) -> str:
        text, usage = await deps.llm.complete(
            deps.auxiliary_model,
            system=SUMMARY_SYSTEM,
            prompt=prompt,
            temperature=0.2,
            max_tokens=deps.auxiliary_max_output_tokens,
            thinking=deps.auxiliary_thinking,
        )
        deps.log_aux_call("compaction", usage)   # 읽기 에이전트와 같이 `/usage`의 보조 호출로 잡힌다
        return text

    return run


def make_compactor(context_budget: int):
    """실행 중에 모델 요청 직전마다 도는 압축기. context_budget이 0이면 아무것도 하지 않는다 (자동 압축 끔)."""
    async def compact(ctx: RunContext[RunDeps], messages: list[ModelMessage]) -> list[ModelMessage]:
        if context_budget <= 0 or len(messages) < 6:
            return messages
        before, source = estimate_tokens(messages)
        if before < context_budget:
            return messages
        deps = ctx.deps
        # 방금 줄인 직후에는 꼬리에 남은 응답이 줄이기 전의 큰 실측값을 들고 있다.
        # 같은 실측값으로 다시 줄이지 않는다.
        if source is not None and deps.scratch.get("compacted_from") is source:
            return messages
        # 줄인 뒤에도 한도를 넘을 수 있다 (지침과 노트, 최근 대화만으로 한도가 거의 찰 때).
        # 그렇다고 요청마다 다시 줄이면 요약만 계속 부르게 된다. 대화가 어느 정도 늘 때까지는 그냥 둔다.
        size = _chars(messages)
        floor = deps.scratch.get("compacted_chars")
        if floor is not None and size < floor + max(_REGROW_CHARS, floor * 0.1):
            if not deps.scratch.get("compaction_warned"):
                deps.scratch["compaction_warned"] = True
                deps.emit({
                    "type": "notice", "level": "warning",
                    "text": "대화를 줄였는데도 컨텍스트 한도를 넘습니다. 지침과 노트, 최근 대화만으로 한도가 거의 찹니다. "
                            "컨텍스트 한도를 올리거나 노트를 줄이면 됩니다.",
                })
            return messages
        compacted, info = await compact_messages(
            messages, context_budget, summarize=summarizer(deps), goal=deps.scratch.get("goal", "")
        )
        if info is None:
            return messages
        deps.scratch["compacted_from"] = source
        deps.scratch["compacted_chars"] = _chars(compacted)
        if info.get("failed"):
            deps.emit({
                "type": "notice", "level": "warning",
                "text": f"이전 대화를 요약하지 못해 기계적으로 줄였다: {info.get('error', '')}",
            })
        deps.emit({"type": "compaction", **{k: v for k, v in info.items() if k not in ("failed", "error")}})
        return compacted

    return compact
