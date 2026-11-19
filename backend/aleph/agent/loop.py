"""에이전트 실행 한 번.

하나의 에이전트가 기본 도구와 사용자 도구를 들고 요청을 수행한다. 모드는 네 가지다.

  manual      수동 — 문서를 바꾸거나 도구를 돌리기 전에 항상 사용자 확인
  auto        자동 — 에이전트가 판단해서 확인을 청한다. 원고 변경은 항상 확인
  autonomous  자율 — 확인하지 않고 끝까지. 사용자에게 묻지도 않는다
  plan        계획 — 읽기와 자료 쓰기만. 도구 실행과 원고 변경은 하지 않는다

이 모듈은 화면을 모른다. 일어나는 일을 `emit(event)`으로 내보낼 뿐이고,
그 이벤트를 저장하고 화면으로 흘려보내는 것은 실행 관리자(manager.py)의 일이다.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter, deque
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from pydantic import BaseModel
from pydantic_ai import Agent, AgentRunResultEvent
from pydantic_ai.capabilities import Caching, Hooks, ProcessHistory, Thinking
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FilePart,
    FunctionToolResultEvent,
    ModelMessage,
    NativeToolCallPart,
    NativeToolReturnPart,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    RetryPromptPart,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
)
from pydantic_ai.usage import UsageLimits

from ..presets.store import Mode, Preset
from ..providers.factory import build_model, build_model_settings
from ..providers.store import ProviderError
from ..tools.agent_tools import agent_tool_catalog, build_agent_tools
from ..tools.definitions import ToolDef, find_tool
from ..tools.runtime import build_user_tools, run_user_tool
from .compaction import estimate_tokens, make_compactor
from .deps import RunDeps
from .history import load_history, sanitize_history, save_history
from .llm import usage_dict
from .native import (
    NATIVE_LABELS,
    native_args,
    native_capabilities,
    NO_RESULT,
    native_note,
    native_result_text,
    save_generated_image,
)

REPEAT_LIMIT = 10   # 같은 도구를 같은 인자로 이만큼 연달아 부르면 헛도는 것으로 보고 멈춘다
CYCLE_WINDOW = 30   # 최근 이만큼의 호출이 CYCLE_KINDS가지 이하의 호출만 번갈아 한 것이면 그것도 헛도는 것이다
CYCLE_KINDS = 3
MANUSCRIPT_LIST_LIMIT = 12_000   # 원고 목록이 이보다 길면 최근에 손댄 장만 펼쳐 보여 준다

MODES: list[dict] = [
    {"id": "manual", "label": "수동", "description": "문서를 바꾸거나 도구를 돌리기 전에 항상 확인합니다."},
    {"id": "auto", "label": "자동", "description": "에이전트가 판단해서 확인을 청합니다. 원고 변경은 항상 확인합니다."},
    {"id": "autonomous", "label": "자율", "description": "확인하지 않고 끝까지 진행합니다."},
    {"id": "plan", "label": "계획", "description": "실행하지 않고 계획만 세웁니다. 자료에만 씁니다."},
]

BASE_INSTRUCTION = """<workspace>
이 작업 공간에는 네 자리가 있습니다.
- 입력: 도구에 넘길 글. 하나뿐입니다. write('입력', …)로 씁니다.
- 출력: 도구가 낸 글. 하나뿐이고, 도구가 돌 때마다 덮입니다.
- 자료(자료/…): 작품의 재료와 메모. 폴더를 자유롭게 만들어 정리합니다. 사용자와 함께 관리합니다.
- 원고(원고/…): 본문. 장 아래 장면으로 나뉩니다. 순서는 이름과 무관하게 따로 관리되고, 번호는 위치에서 나옵니다. 장과 장면에 제목을 다는 자리는 없습니다. 글에 제목이 필요하다고 사용자가 하면 본문에 적습니다.

사용자가 만든 도구는 입력만 읽고 출력에만 씁니다. 도구는 이 대화를 보지 못합니다. 그래서 이렇게 씁니다.
1. 도구에 필요한 것을 모두 입력에 적습니다. 자료나 원고의 내용이 필요하면 다시 적지 말고 `@include:자료/인물/서윤`, `@include:원고/s3`, `@include:원고`(전체)처럼 끌어옵니다. 도구가 돌 때 그 자리에 내용이 들어갑니다.
2. 도구를 부릅니다.
3. 출력을 읽고 판단합니다. 원고에 올리려면 insert_scene(from_output=true)을, 보관하려면 move('출력', '자료/…')를 쓰고, 고쳐야 하면 입력을 고쳐 다시 돌립니다.
출력은 다음 도구가 돌면 사라집니다. 남겨야 하는 것은 그 전에 옮기십시오.

원고는 전체를 읽지 않아도 되도록 장면마다 요약을 붙여 둡니다. 목록의 요약을 보고 필요한 장면만 read로 읽으십시오.
요약은 저절로 생기지 않습니다. 장면을 넣거나 고친 뒤에는 요약을 붙이십시오.
- 방금 쓰거나 읽어서 내용을 아는 장면이면 set_summary로 직접 적습니다.
- 요약 도구가 있으면 보통 도구처럼 써도 됩니다: 입력에 `@include:원고/s3`를 적고 도구를 돌린 뒤 set_summary(from_output=true).
- 장면이 여럿이면 summarize_scenes가 한 번에 합니다 (긴 글을 나눈 뒤, 사용자가 원고를 정리해 달라고 할 때).
목록에 '(요약 없음)'이나 '(본문이 바뀐 뒤 요약을 고치지 않음)'이라고 나온 요약은 믿지 마십시오. 그 장면을 다루게 되면 고칩니다.
여러 장면이나 긴 자료를 훑어야 답할 수 있는 일(이 인물이 앞에서 어떻게 그려졌는지, 설정이 어긋나는 곳이 있는지, 어떤 일이 어디서 일어났는지)은 직접 다 읽지 말고 explore에 맡기십시오. 읽은 글은 이 대화에 쌓이지 않고 결론만 돌아옵니다. 고칠 대목을 직접 봐야 하는 장면만 read로 읽습니다.
긴 글을 장면으로 나눌 때는 글을 다시 적지 말고 split을 씁니다. 사용자의 글은 시키지 않는 한 고쳐 쓰지 않습니다.

[수정 방지]가 붙은 문서는 고칠 수 없습니다. [노트]가 붙은 자료는 매 요청마다 자동으로 읽힙니다(<note>). 이 작업에서 계속 기억해야 할 것(지금의 계획, 합의한 방향, 사용자의 선호)은 자료에 적고 set_note로 노트로 지정하십시오. 더는 매번 볼 필요가 없으면 노트를 끕니다.
아래 <standing_context>는 이 요청을 시작할 때의 상태입니다. 판단하기 전에는 지금 적혀 있는 것을 다시 읽으십시오.
</workspace>"""

MODE_INSTRUCTION = {
    "manual": """<mode>
지금은 수동 모드입니다. 문서를 바꾸거나 도구를 돌릴 때마다 사용자가 확인합니다 (입력을 쓰는 것은 확인 없이 되고, 도구를 돌리기 전에 입력이 통째로 사용자에게 보입니다).
반려되면 사유를 읽고 그 뜻을 따르십시오. 판단이 갈리는 방향 문제는 ask_user로 묻습니다.
</mode>""",
    "auto": """<mode>
지금은 자동 모드입니다. 원고를 바꾸는 일은 항상 사용자 확인을 거칩니다. 그 밖의 변경과 도구 실행은 당신이 판단합니다.
- 사용자가 보고 결정해야 할 만한 것에는 confirm=true로 확인을 청합니다: 사용자가 직접 쓴 자료를 크게 고치거나 지울 때, 되돌리기 번거로운 정리(여러 문서를 옮기거나 합칠 때), 사용자가 예상하지 못할 일을 할 때.
- 사소한 것은 그냥 합니다: 입력 준비, 메모와 계획의 갱신, 자신이 방금 만든 문서의 수정, 사용자가 방금 시킨 그대로의 일.
- 방향이 갈리는 문제는 확인이 아니라 ask_user로 묻습니다.
반려되면 사유를 읽고 그 뜻을 따르십시오.
</mode>""",
    "autonomous": """<mode>
지금은 자율 모드입니다. 사용자는 자리에 없고, 물어볼 상대가 없습니다. 확인을 청하지 않습니다(confirm은 쓰지 않습니다).
판단이 갈리면 스스로 정하고, 그 결정과 이유를 자료에 적어 두십시오. 요청받은 일을 끝까지 하십시오.
</mode>""",
    "plan": """<mode>
지금은 계획 모드입니다. 실행하지 않고 계획만 세웁니다.
- 읽기는 자유롭게 합니다. 쓰기는 자료에만 합니다. 도구를 돌리거나 원고·입력·출력을 바꾸지 않습니다.
- 무엇을 어떤 순서로 할지, 어떤 도구를 어떤 입력으로 돌릴지를 자료에 적습니다. 계획을 적는 자료가 이미 있으면 거기에 적고, 없으면 새 문서를 만듭니다 (예: 자료/계획). 필요하면 set_note로 노트로 지정합니다.
- 정해야 할 것이 있으면 ask_user로 묻습니다. 마지막에 계획을 짧게 요약해 보이십시오. 실행은 사용자가 모드를 바꾼 뒤에 합니다.
</mode>""",
}


class RunConfig(BaseModel):
    goal: str
    mode: Mode = "auto"
    preset: Preset
    agent_model: str
    auxiliary_model: str
    bypass_locks: bool = False
    tool: str = ""                     # 사용자가 지정한 도구의 영문 이름 (`/집필 …`)
    kind: str = "agent"                # agent | tool (도구를 직접 돌리는 실행)
    conversation: str = "main"         # 이 실행이 도는 대화 (작업 하나에 대화가 여럿 있을 수 있다)
    trial: dict | None = None          # kind=tool일 때의 시험 실행 (runtime.run_user_tool 참고)
    # 아래 값은 전부 프리셋에서 온다 (context.run_config).
    agent_temperature: float | None = None
    thinking: str = "default"  # default | off | low | medium | high
    max_output_tokens: int | None = None
    context_budget: int = 150_000
    auto_compact: bool = True          # 꺼 두면 한도를 넘어도 대화를 줄이지 않는다 (작업마다 정한다)
    auxiliary_temperature: float | None = None
    auxiliary_thinking: str = "default"
    auxiliary_max_output_tokens: int | None = None
    auxiliary_max_input_tokens: int | None = None
    image_model: str = ""               # 그림을 만드는 모델. 비면 에이전트에게 `generate_image`를 주지 않는다

    def manifest(self, run_id: str) -> dict:
        """제작 기록용 — 이 실행을 만든 설정 전부."""
        return {
            "run_id": run_id,
            "conversation": self.conversation,
            "kind": self.kind,
            "trial": {k: v for k, v in self.trial.items() if k != "input"} if self.trial else None,
            "goal": self.goal,
            "tool": self.tool,
            "mode": self.mode,
            "bypass_locks": self.bypass_locks,
            "preset_id": self.preset.id,
            "preset_name": self.preset.name,
            "instruction": self.preset.instruction,
            # 앱이 지침 앞에 붙이는 글. 화면에는 보이지 않으므로 여기에 남긴다.
            "base_instruction": BASE_INSTRUCTION,
            "mode_instruction": MODE_INSTRUCTION[self.mode],
            "tools": [t.model_dump() for t in self.preset.tools],
            "agent_model": self.agent_model,
            "auxiliary_model": self.auxiliary_model,
            "agent_temperature": self.agent_temperature,
            "thinking": self.thinking,
            "max_output_tokens": self.max_output_tokens,
            "context_budget": self.context_budget,
            "auto_compact": self.auto_compact,
            "auxiliary_temperature": self.auxiliary_temperature,
            "auxiliary_thinking": self.auxiliary_thinking,
            "auxiliary_max_output_tokens": self.auxiliary_max_output_tokens,
            "auxiliary_max_input_tokens": self.auxiliary_max_input_tokens,
            "image_model": self.image_model,
        }


def build_instructions(config: RunConfig, standing: str, natives: set[str] = frozenset()) -> str:
    parts = [BASE_INSTRUCTION, MODE_INSTRUCTION[config.mode]]
    if natives:
        parts.append(native_note(natives))
    if config.bypass_locks:
        parts.append("<bypass>\n사용자가 권한 무시를 켰습니다. 이번에는 [수정 방지]가 붙은 문서도 고칠 수 있습니다. 필요한 것만 고치십시오.\n</bypass>")
    parts.append(f"<standing_context>\n{standing}\n</standing_context>")
    if config.preset.instruction.strip():
        parts.append(config.preset.instruction.strip())
    return "\n\n".join(parts)


def user_message(config: RunConfig) -> str:
    """에이전트에게 넘길 요청. 사용자가 도구를 지정했으면 그 뜻을 앞에 밝힌다."""
    tool = find_tool(config.preset.tools, config.tool) if config.tool else None
    if tool is None:
        return config.goal
    return (
        f"[사용자가 '{tool.title}' 도구({tool.name})를 쓰라고 지정했습니다. "
        "아래 요청을 반영해 입력을 준비하거나 고친 뒤 이 도구를 돌리십시오.]\n\n"
        f"{config.goal}"
    )


class RepeatedCallError(RuntimeError):
    """에이전트가 같은 도구를 같은 인자로 되풀이해 부르고 있다."""

    def __init__(self, label: str, cycle: bool = False):
        super().__init__(label)
        self.label = label
        self.cycle = cycle   # 한 가지가 아니라 몇 가지 호출을 번갈아 되풀이했다


def _is_library_signal(exc: BaseException) -> bool:
    """Pydantic AI가 흐름 제어에 쓰는 예외(재시도 요청 등)는 건드리지 않는다."""
    return type(exc).__module__.startswith("pydantic_ai")


def steer_message(texts: list[str], notices: list[str] | None = None) -> str:
    """실행 중에 끼워 넣는 말: 앱의 알림과 사용자가 보낸 말."""
    parts = []
    if notices:
        parts.append("[앱의 알림]\n" + "\n".join(notices))
    if texts:
        parts.append("[사용자가 실행 중에 보낸 말입니다. 지금 하던 일에 반영하십시오.]\n" + "\n\n".join(texts))
    return "\n\n".join(parts)


def _sum_usage(usages: list[dict]) -> dict:
    """구간별 사용량을 더한다. 비용은 전부 알 때만 낸다."""
    total: dict[str, Any] = {}
    for u in usages:
        for key in ("prompt_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"):
            if key in u:
                total[key] = total.get(key, 0) + (u.get(key) or 0)
    if usages and all("cost_usd" in u for u in usages if u):
        costs = [u["cost_usd"] for u in usages if u]
        if costs:
            total["cost_usd"] = sum(costs)
    return total


async def _tool_hook(ctx, *, call, tool_def, args, handler) -> Any:
    try:
        result = await handler(args)
    except Exception as e:
        if _is_library_signal(e):
            raise
        # 도구 내부의 예상 못 한 오류로 실행 전체가 죽지 않게, 오류를 결과로 돌려준다.
        result = f"오류: 도구 '{tool_def.name}' 실행 중 문제가 생겼습니다. ({type(e).__name__}: {e})"
    deps: RunDeps = ctx.deps
    if deps.steer or deps.notices:
        # 사용자가 그 사이에 보낸 말(과 앱의 알림)을 이 도구의 결과 바로 뒤에 끼워 넣는다.
        texts, notices = list(deps.steer), list(deps.notices)
        deps.steer.clear()
        deps.notices.clear()
        try:
            ctx.enqueue(steer_message(texts, notices))
        except Exception:
            deps.steer[:0] = texts   # 끼워 넣지 못했으면 실행이 끝날 때 다시 전한다
            deps.notices[:0] = notices
    return result


def _result_text(part: Any) -> tuple[str, bool]:
    if isinstance(part, RetryPromptPart):
        content = part.content
        return (content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, default=str)), False
    content = getattr(part, "content", "")
    if isinstance(content, str):
        return content, not content.startswith("오류")
    return json.dumps(content, ensure_ascii=False, default=str), True


def friendly_error(exc: BaseException) -> str:
    name = type(exc).__name__
    text = str(exc)
    status = getattr(exc, "status_code", None)
    if isinstance(exc, ProviderError):
        return text
    if status in (401, 403) or "Authentication" in name:
        return f"제공자가 인증을 거절했습니다. API 키를 확인해야 합니다. ({name}: {text[:300]})"
    if status == 404 or "NotFound" in name:
        return f"모델을 찾지 못했습니다. 모델 이름을 확인해야 합니다. ({name}: {text[:300]})"
    if status == 429 or "RateLimit" in name or "Quota" in name:
        return f"제공자의 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도하면 됩니다. ({name}: {text[:300]})"
    if "ContextWindow" in name:
        return f"대화가 모델이 받을 수 있는 길이를 넘었습니다. 에이전트 패널에서 컨텍스트 한도를 낮추면 더 일찍 줄입니다. ({text[:300]})"
    if "Connection" in name or "Timeout" in name or "ConnectError" in name:
        return f"제공자에 연결하지 못했습니다. 인터넷 연결과 제공자의 주소를 확인해야 합니다. ({text[:300]})"
    return f"모델을 부르다가 문제가 생겼습니다. ({name}: {text[:600]})"


def tool_labels(preset: Preset) -> dict[str, str]:
    labels = {item["name"]: item["label"] for item in agent_tool_catalog()}
    labels.update({t.name: t.title for t in preset.tools})
    return labels


async def prepare_context(deps: RunDeps) -> str:
    """요청을 시작하기 전에, 에이전트가 들고 갈 상태를 만든다."""
    standing = deps.docs.standing_context(manuscript_limit=MANUSCRIPT_LIST_LIMIT)
    deps.docs.mark_run_started()   # 여기까지가 "지난 실행 이후 사용자가 한 일"의 기준점이다
    deps.changed.clear()
    return standing


async def execute_run(
    config: RunConfig,
    *,
    run_id: str,
    deps: RunDeps,
    providers,
    history_path,
    emit: Callable[[dict], None],
) -> str:
    """실행을 끝까지 돌리고 상태를 돌려준다: completed | stopped | stalled | error.

    도구 호출 수에는 한도가 없다. 같은 호출이 되풀이될 때만 멈춘다 (stalled).
    """
    started = time.time()
    tool_count = 0
    last_call: tuple[str, str] | None = None
    repeats = 0
    recent: deque[tuple[str, str]] = deque(maxlen=CYCLE_WINDOW)
    tools_used: Counter[str] = Counter()
    status = "completed"
    handle = None
    history: list[ModelMessage] = sanitize_history(load_history(history_path))
    deps.scratch["goal"] = config.goal
    labels = tool_labels(config.preset)
    user_tools = {t.name for t in config.preset.tools}
    deps.rejected = False
    usages: list[dict] = []

    try:
        model, provider = build_model(config.agent_model, providers)
        settings = build_model_settings(
            config.agent_model,
            provider,
            temperature=config.agent_temperature,
            max_tokens=config.max_output_tokens,
            thinking=config.thinking,
        )
        tools = build_agent_tools(config.mode, image=bool(config.image_model))
        if config.mode != "plan":
            tools += build_user_tools(config.preset.enabled_tools())

        capabilities: list[Any] = [
            Caching(),
            ProcessHistory(make_compactor(config.context_budget if config.auto_compact else 0)),
            Hooks(tool_execute=_tool_hook),
        ]
        if config.thinking == "off":
            capabilities.append(Thinking(False))
        elif config.thinking in ("low", "medium", "high"):
            capabilities.append(Thinking(config.thinking))
        native_caps, natives = native_capabilities(config.preset, model)
        capabilities += native_caps

        agent: Agent[RunDeps, str] = Agent(
            model,
            instructions=build_instructions(config, await prepare_context(deps), natives),
            tools=tools,
            deps_type=RunDeps,
            capabilities=capabilities,
        )

        # 사용자가 실행 중에 보낸 말은 보통 도구 호출이 끝날 때 끼워 넣는다 (_tool_hook).
        # 에이전트가 도구 없이 끝내려던 참에 온 말은 여기서 받아 같은 실행 안에서 이어 간다.
        prompt: str = user_message(config)
        messages_so_far: list[ModelMessage] = history
        while True:
            part_ids: dict[int, str] = {}
            waiting: dict[str, Any] = {}   # 결과가 아직 비어 있는 제공자 도구의 결과 조각 (호출 id → 조각)

            def flush_native(final: bool = False) -> None:
                """내용이 찬 제공자 도구의 결과를 내보낸다. final이면 비어 있어도 내보낸다 (그 응답이 끝났다)."""
                for call_id, part in list(waiting.items()):
                    text = native_result_text(part.tool_name, part.content)
                    if not text and not final:
                        continue
                    del waiting[call_id]
                    emit({
                        "type": "tool_result", "tool": part.tool_name, "label": NATIVE_LABELS.get(part.tool_name, part.tool_name),
                        "native": True, "tool_call_id": call_id,
                        "result": text or NO_RESULT.get(part.tool_name, "제공자가 결과를 따로 돌려주지 않았습니다."),
                        "ok": True, "changed": [],
                    })

            async with agent.run_stream_events(
                prompt,
                message_history=messages_so_far or None,
                deps=deps,
                model_settings=settings,
                # 라이브러리의 기본값(요청 50번)을 포함해 횟수 한도를 전부 푼다
                usage_limits=UsageLimits(request_limit=None, tool_calls_limit=None),
            ) as events:
                handle = events
                async for event in events:
                    if isinstance(event, PartStartEvent):
                        part = event.part
                        if isinstance(part, (TextPart, ThinkingPart)):
                            part_ids[event.index] = uuid4().hex[:12]
                            if part.content:
                                kind = "text_delta" if isinstance(part, TextPart) else "thinking_delta"
                                emit({"type": kind, "id": part_ids[event.index], "delta": part.content})
                        elif isinstance(part, FilePart):
                            # 모델이 만든 이미지. 자료에 저장하고, 어디에 저장됐는지 에이전트에게 알린다.
                            saved = save_generated_image(deps.docs, part.content, run_id=run_id)
                            if saved:
                                deps.notices.append(
                                    f"방금 만든 이미지는 '{saved}'에 저장되었습니다. 원고에 넣으려면 그 자리에 ![설명]({saved})라고 적습니다."
                                )
                                image_id = f"image-{uuid4().hex[:10]}"   # 제공자가 호출을 따로 알려 주지 않을 수 있어, 짝을 만들어 보낸다
                                emit({
                                    "type": "tool_call", "tool": "image_generation", "label": NATIVE_LABELS["image_generation"],
                                    "user_tool": False, "native": True, "tool_call_id": image_id, "args": {},
                                    "tool_call_index": tool_count,
                                })
                                emit({
                                    "type": "tool_result", "tool": "image_generation", "label": NATIVE_LABELS["image_generation"],
                                    "native": True, "tool_call_id": image_id, "result": f"이미지를 '{saved}'에 저장했습니다.",
                                    "ok": True, "changed": [saved],
                                })
                        elif isinstance(part, NativeToolReturnPart):
                            # 제공자가 실행한 도구의 결과. 끝 이벤트가 따로 없고, 내용이 뒤늦게 채워지기도 한다
                            # (Gemini는 검색의 출처 목록을 응답의 맨 끝에 채운다). 내용이 찰 때까지 들고 있는다.
                            waiting[part.tool_call_id] = part
                            flush_native()
                    elif isinstance(event, PartDeltaEvent):
                        delta = event.delta
                        pid = part_ids.get(event.index)
                        if pid and isinstance(delta, TextPartDelta) and delta.content_delta:
                            emit({"type": "text_delta", "id": pid, "delta": delta.content_delta})
                        elif pid and isinstance(delta, ThinkingPartDelta) and delta.content_delta:
                            emit({"type": "thinking_delta", "id": pid, "delta": delta.content_delta})
                    elif isinstance(event, PartEndEvent):
                        part = event.part
                        pid = part_ids.pop(event.index, None) or uuid4().hex[:12]
                        if isinstance(part, TextPart) and part.content.strip():
                            emit({"type": "text", "id": pid, "text": part.content})
                        elif isinstance(part, ThinkingPart) and (part.content or "").strip():
                            emit({"type": "thinking", "id": pid, "text": part.content})
                        elif isinstance(part, NativeToolCallPart):
                            # 제공자가 실행하는 도구(웹 검색 등). 우리 쪽 도구 호출 수에는 넣지 않는다.
                            try:
                                args = part.args_as_dict()
                            except Exception:
                                args = {"_raw": str(part.args)}
                            tools_used[part.tool_name] += 1
                            emit({
                                "type": "tool_call", "tool": part.tool_name, "label": NATIVE_LABELS.get(part.tool_name, part.tool_name),
                                "user_tool": False, "native": True, "tool_call_id": part.tool_call_id,
                                "args": native_args(part.tool_name, args),
                                "tool_call_index": tool_count,
                            })
                    elif isinstance(event, FunctionToolCallEvent):
                        flush_native(final=True)   # 모델의 응답이 끝나고 우리 쪽 도구가 돌기 시작했다
                        tool_count += 1
                        name = event.part.tool_name
                        tools_used[name] += 1
                        try:
                            args = event.part.args_as_dict()
                        except Exception:
                            args = {"_raw": str(event.part.args)}
                        emit({
                            "type": "tool_call",
                            "tool": name,
                            "label": labels.get(name, name),
                            "user_tool": name in user_tools,
                            "tool_call_id": event.part.tool_call_id,
                            "args": args,
                            "tool_call_index": tool_count,
                        })
                        signature = (name, json.dumps(args, sort_keys=True, ensure_ascii=False, default=str))
                        repeats = repeats + 1 if signature == last_call else 1
                        last_call = signature
                        recent.append(signature)
                        if repeats >= REPEAT_LIMIT:
                            raise RepeatedCallError(labels.get(name, name))
                        if len(recent) == CYCLE_WINDOW and len(set(recent)) <= CYCLE_KINDS:
                            raise RepeatedCallError(labels.get(name, name), cycle=True)
                    elif isinstance(event, FunctionToolResultEvent):
                        text, ok = _result_text(event.part)
                        name = getattr(event.part, "tool_name", "") or ""
                        changed = list(dict.fromkeys(deps.changed))
                        deps.changed.clear()
                        rejected, deps.rejected = deps.rejected, False
                        result_id = getattr(event.part, "tool_call_id", "") or ""
                        trail = deps.scratch.get("trails", {}).pop(result_id, None)
                        emit({
                            "type": "tool_result",
                            "tool": name,
                            "label": labels.get(name, name),
                            "tool_call_id": result_id,
                            "result": text,
                            "ok": ok,
                            "changed": changed,
                            **({"rejected": True} if rejected else {}),
                            **({"trail": trail} if trail else {}),   # 읽기 에이전트가 본 것
                        })
                    elif isinstance(event, AgentRunResultEvent):
                        pass  # 끝. 사용량은 아래에서 handle로 읽는다.
                    if waiting:
                        flush_native(final=isinstance(event, AgentRunResultEvent))
            try:
                usages.append(usage_dict(handle.usage) or {})
            except Exception:
                pass
            if not deps.steer and not deps.notices:
                break
            prompt = steer_message(deps.steer, deps.notices)
            deps.steer.clear()
            deps.notices.clear()
            messages_so_far = list(handle.all_messages())

    except asyncio.CancelledError:
        status = "stopped"
        task = asyncio.current_task()
        if task is not None:
            task.uncancel()  # 중단 요청은 받아들였다 — 뒷정리(대화 기억 저장)는 마저 한다
    except RepeatedCallError as e:
        status = "stalled"
        if e.cycle:
            emit({"type": "error", "error": f"같은 도구 호출 몇 가지만 {CYCLE_WINDOW}번 넘게 되풀이해서 멈췄습니다 (마지막은 '{e.label}'). 에이전트가 헛돌고 있을 수 있습니다."})
        else:
            emit({"type": "error", "error": f"'{e.label}' 도구를 같은 내용으로 {REPEAT_LIMIT}번 연달아 불러서 멈췄습니다. 에이전트가 헛돌고 있을 수 있습니다."})
    except Exception as e:
        status = "error"
        emit({"type": "error", "error": friendly_error(e)})

    # --- 뒷정리: 대화 기억 저장, 마무리 이벤트 ---
    messages: list[ModelMessage] | None = None
    if handle is not None:
        try:
            messages = list(handle.all_messages())
        except Exception:
            messages = None
        if status != "completed":
            try:
                usages.append(usage_dict(handle.usage) or {})   # 중간에 끊긴 구간의 사용량
            except Exception:
                pass
    context_tokens = 0
    if messages:
        try:
            save_history(history_path, sanitize_history(messages))
        except Exception as e:
            emit({"type": "notice", "level": "warning", "text": f"대화 기억을 저장하지 못했습니다: {e}"})
        try:
            context_tokens = int(estimate_tokens(messages)[0])
        except Exception:
            context_tokens = 0
    if context_tokens:
        try:
            deps.sessions.update_conversation(deps.session_id, deps.conversation, context_tokens=context_tokens)
        except Exception:
            pass

    emit({
        "type": "done",
        "status": status,
        "run_id": run_id,
        "total_tool_calls": tool_count,
        "elapsed_sec": round(time.time() - started, 1),
        "tools_used": dict(tools_used),
        "usage": {"agent_model": config.agent_model, **_sum_usage(usages), "context_tokens": context_tokens},
    })
    return status


async def execute_tool_run(
    tool: ToolDef, *, run_id: str, deps: RunDeps, emit: Callable[[dict], None], trial: dict | None = None
) -> str:
    """사용자가 도구를 직접 돌리는 실행. 에이전트를 거치지 않는다. trial이면 출력을 건드리지 않는 시험 실행."""
    started = time.time()
    call_id = uuid4().hex[:12]
    status = "completed"
    mark = {"trial": True} if trial is not None else {}
    emit({
        "type": "tool_call", "tool": tool.name, "label": tool.title, "user_tool": True, "tool_call_id": call_id,
        "args": {}, "tool_call_index": 1, "direct": True, **mark,
    })
    try:
        ok, message = await run_user_tool(tool, deps, by="user", tool_call_id=call_id, trial=trial)
    except asyncio.CancelledError:
        ok, message, status = False, "중단했습니다.", "stopped"
        task = asyncio.current_task()
        if task is not None:
            task.uncancel()
    emit({
        "type": "tool_result", "tool": tool.name, "label": tool.title, "tool_call_id": call_id,
        "result": message, "ok": ok, "changed": list(dict.fromkeys(deps.changed)), "direct": True, **mark,
    })
    if status == "completed" and not ok:
        status = "error"
    emit({
        "type": "done", "status": status, "run_id": run_id, "total_tool_calls": 1,
        "elapsed_sec": round(time.time() - started, 1), "tools_used": {tool.name: 1},
        "usage": {"agent_model": deps.tool_settings(tool, (trial or {}).get("model") or "")["model"]},
    })
    return status
