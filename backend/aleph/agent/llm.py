"""단발 모델 호출 — 사용자 도구, 대화 압축, 읽기 에이전트가 쓴다.

제공자를 모르는 채로 '제공자:모델' 문자열만 넘기면 된다.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pydantic_ai import Agent, Tool
from pydantic_ai.capabilities import NativeTool, Thinking
from pydantic_ai.messages import BinaryContent, BinaryImage, PartDeltaEvent, PartStartEvent, TextPart, TextPartDelta
from pydantic_ai.native_tools import ImageGenerationTool
from pydantic_ai.usage import UsageLimits

from ..providers.factory import build_model, build_model_settings
from ..providers.store import ProviderStore


def usage_dict(usage: Any) -> dict | None:
    """Pydantic AI의 사용량 객체를 기록용 dict로."""
    if usage is None:
        return None
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    data = {
        "prompt_tokens": inp,
        "output_tokens": out,
        "total_tokens": inp + out,
        "cache_read_tokens": getattr(usage, "cache_read_tokens", 0) or 0,
        "cache_write_tokens": getattr(usage, "cache_write_tokens", 0) or 0,
    }
    cost = getattr(usage, "cost", None)
    if cost is not None:
        try:
            data["cost_usd"] = float(cost)
        except (TypeError, ValueError):
            pass
    return data


class LlmService:
    def __init__(self, providers: ProviderStore):
        self.providers = providers

    async def complete(
        self,
        model_ref: str,
        *,
        system: str | None,
        prompt: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        thinking: str = "default",
        tools: list[Tool] | None = None,
        deps: Any = None,
        max_steps: int | None = None,
        on_delta: Callable[[str], None] | None = None,
    ) -> tuple[str, dict | None]:
        """(텍스트, 사용량). tools를 주면 그 도구를 쓰며 여러 번 돌 수 있다.

        on_delta를 주면 모델이 쓰는 글을 조각 단위로 흘려보낸다 (화면에서 써지는 과정을 보여줄 때).
        thinking: default(모델의 기본값) | off | low | medium | high.
        """
        model, provider = build_model(model_ref, self.providers)
        settings = build_model_settings(
            model_ref, provider, temperature=temperature, max_tokens=max_tokens, thinking=thinking
        )
        capabilities: list[Any] = []
        if thinking == "off":
            capabilities.append(Thinking(False))
        elif thinking in ("low", "medium", "high"):
            capabilities.append(Thinking(thinking))
        agent: Agent[Any, str] = Agent(
            model,
            instructions=system or None,
            tools=tools or [],
            deps_type=type(deps) if deps is not None else type(None),
            capabilities=capabilities,
        )
        # 횟수 한도는 걸지 않는다 (라이브러리의 기본값은 요청 50번이다). 부르는 쪽이 정할 때만 건다.
        limits = UsageLimits(request_limit=max_steps or None, tool_calls_limit=None)
        if on_delta is None:
            result = await agent.run(prompt, deps=deps, model_settings=settings, usage_limits=limits)
        else:
            wrote = False
            async with agent.run_stream_events(
                prompt, deps=deps, model_settings=settings, usage_limits=limits
            ) as events:
                async for event in events:
                    if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                        if wrote:
                            on_delta("\n\n")  # 도구를 쓰고 돌아와 다시 쓰기 시작한 경우
                        if event.part.content:
                            on_delta(event.part.content)
                            wrote = True
                    elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        if event.delta.content_delta:
                            on_delta(event.delta.content_delta)
                            wrote = True
                result = events.result
        text = result.output if isinstance(result.output, str) else str(result.output)
        return text.strip(), usage_dict(getattr(result, "usage", None))

    async def image(
        self, model_ref: str, *, prompt: str, references: list[tuple[bytes, str]] | None = None,
    ) -> tuple[tuple[bytes, str] | None, str, dict | None]:
        """이미지 모델에 그림을 시킨다. ((그림의 바이트, 종류) 또는 None, 모델이 글로 한 말, 사용량).

        references는 같이 보일 그림들 (바이트, 종류). 인물이나 화풍을 맞출 때 쓴다.
        그림을 만들지 못하는 모델이면 라이브러리가 UserError를 낸다 (부르는 쪽이 알린다).
        Gemini는 사용자가 이미지 모델로 골랐으면 이름과 상관없이 그림을 내는 모델로 다룬다 (build_model의 image).
        """
        model, provider = build_model(model_ref, self.providers, image=True)
        settings = build_model_settings(model_ref, provider)
        profile = getattr(model, "profile", None) or {}
        # 그림을 제공자의 도구로 만드는 모델(OpenAI)은 그 도구를 붙여 줘야 한다. 그림을 바로 내는 모델(Gemini)에도 붙여서 해가 없다.
        native = ImageGenerationTool in profile.get("supported_native_tools", frozenset())
        agent: Agent[None, Any] = Agent(
            model,
            output_type=[BinaryImage, str],
            capabilities=[NativeTool(ImageGenerationTool())] if native else [],
        )
        content: Any = prompt
        if references:
            content = [prompt, *(BinaryContent(data=data, media_type=kind) for data, kind in references)]
        result = await agent.run(content, model_settings=settings, usage_limits=UsageLimits(request_limit=3, tool_calls_limit=None))
        usage = usage_dict(getattr(result, "usage", None))
        made = result.output
        if isinstance(made, BinaryContent) and made.data:
            return (bytes(made.data), str(made.media_type or "image/png")), "", usage
        return None, str(made or "").strip(), usage
