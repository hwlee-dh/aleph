"""'제공자id:모델이름' 문자열을 실제 모델 객체로 바꾼다.

제공자별 분기는 이 파일에만 있다. 호출하는 쪽(에이전트 루프, 도구, 요약)은
모델 참조 문자열만 넘기면 된다. 키는 환경변수에 심지 않고 요청마다 제공자
객체에 직접 넣으므로, 여러 실행이 서로 다른 키로 동시에 돌 수 있다.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic_ai.models import Model

from .store import ProviderError, ProviderStore, ResolvedProvider, split_model_ref

class _QuietAfc(logging.Filter):
    """구글 SDK가 "Tools at indices [...] are not compatible with automatic function calling (AFC)"라고 찍는 경고를 거른다.

    AFC는 SDK가 파이썬 함수를 직접 불러 주는 기능이다. ALEPH의 도구는 엔진이 돌리므로 원래 쓰지 않는다.
    웹 검색 같은 제공자 도구를 함께 켠 실행마다 이 줄이 찍혀서 콘솔만 어지럽힌다. 다른 경고는 그대로 둔다.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return "not compatible with automatic function calling (AFC)" not in str(record.msg)


_GENAI_LOGGER = logging.getLogger("google_genai.models")
if not any(isinstance(f, _QuietAfc) for f in _GENAI_LOGGER.filters):
    _GENAI_LOGGER.addFilter(_QuietAfc())


# 문학·서사 창작은 수위 있는 내용을 다루므로 Gemini 안전 필터는 기본으로 끈다.
_GOOGLE_SAFETY_OFF = [
    {"category": c, "threshold": "OFF"}
    for c in (
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
    )
]


# 라이브러리는 Gemini가 그림을 내는 모델인지를 이름에 'image'가 들어 있는지로 정한다.
# 그래서 'nano-banana-pro-preview'처럼 이름이 다른 이미지 모델은 요청을 보내기도 전에 걸러진다.
# 사용자가 이미지 모델로 고른 것이면 이름과 상관없이 그림을 내는 모델로 다룬다.
# 값은 라이브러리가 이름에 'image'가 든 모델에 주는 것과 같다 (그림 모델은 함수 도구를 못 쓴다).
_GOOGLE_IMAGE_PROFILE: dict[str, Any] = {
    "supports_image_output": True,
    "supports_tools": False,
    "supports_tool_return_schema": False,
    "supports_video_input": False,
}


# 테스트·시연용 가짜 모델 등록부. 실제 제공자 없이 전체 흐름을 돌려 볼 때 쓴다.
_TEST_MODELS: dict[str, Model] = {}


def register_test_model(ref: str, model: Model) -> None:
    _TEST_MODELS[ref] = model


def is_test_model(ref: str) -> bool:
    return ref in _TEST_MODELS


def test_model_names(provider_id: str) -> list[str]:
    """이 제공자 id로 등록된 가짜 모델의 이름들 (시연 서버가 모델 목록을 보여줄 때 쓴다)."""
    prefix = f"{provider_id}:"
    return sorted(ref[len(prefix):] for ref in _TEST_MODELS if ref.startswith(prefix))


def build_model(ref: str, store: ProviderStore, *, image: bool = False) -> tuple[Model, ResolvedProvider]:
    """image=True는 이 모델을 그림을 만드는 데 쓴다는 뜻이다 (프리셋의 이미지 모델)."""
    if ref in _TEST_MODELS:
        return _TEST_MODELS[ref], ResolvedProvider(
            id="test", kind="test", label="테스트", api_key=None, base_url=None, extra={}
        )
    provider_id, model_name = split_model_ref(ref)
    p = store.resolve(provider_id)
    try:
        return _build(p, model_name, image=image), p
    except ProviderError:
        raise
    except Exception as e:  # SDK 초기화 실패(잘못된 주소·자격 증명 등)를 읽을 수 있는 말로
        raise ProviderError(f"'{ref}' 모델을 준비하지 못했습니다: {type(e).__name__}: {e}") from e


def _build(p: ResolvedProvider, model_name: str, *, image: bool = False) -> Model:
    kind = p.kind
    as_image = _GOOGLE_IMAGE_PROFILE if image and "image" not in model_name else None

    if kind == "google":
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google import GoogleProvider

        return GoogleModel(model_name, provider=GoogleProvider(api_key=p.api_key), profile=as_image)

    if kind == "vertex":
        if model_name.startswith("claude"):
            return _vertex_claude(p, model_name)
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google_cloud import GoogleCloudProvider

        from .vertex import resolve_vertex_auth

        provider = GoogleCloudProvider(**resolve_vertex_auth(p).genai_kwargs())
        return GoogleModel(model_name, provider=provider, profile=as_image)

    if kind == "anthropic":
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        return AnthropicModel(model_name, provider=AnthropicProvider(api_key=p.api_key))

    if kind == "openai":
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider

        return OpenAIResponsesModel(model_name, provider=OpenAIProvider(api_key=p.api_key))

    if kind == "openrouter":
        from pydantic_ai.models.openrouter import OpenRouterModel
        from pydantic_ai.providers.openrouter import OpenRouterProvider

        return OpenRouterModel(model_name, provider=OpenRouterProvider(api_key=p.api_key))

    if kind == "deepseek":
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.deepseek import DeepSeekProvider

        return OpenAIChatModel(model_name, provider=DeepSeekProvider(api_key=p.api_key))

    if kind == "ollama":
        from pydantic_ai.models.ollama import OllamaModel
        from pydantic_ai.providers.ollama import OllamaProvider

        return OllamaModel(model_name, provider=OllamaProvider(base_url=p.base_url))

    if kind in ("xai", "lmstudio", "openai_compatible"):
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai_compatible import OpenAICompatibleProvider

        provider = OpenAICompatibleProvider(
            p.id,
            base_url=p.base_url,
            # 로컬 서버는 키를 검사하지 않지만 SDK가 빈 값을 거부하므로 자리만 채운다.
            api_key=p.api_key or "not-needed",
        )
        return OpenAIChatModel(model_name, provider=provider)

    raise ProviderError(f"지원하지 않는 제공자 종류: {kind}")


def _vertex_claude(p: ResolvedProvider, model_name: str) -> Model:
    """Vertex AI에 올라와 있는 Claude 모델. 서비스 계정 키 파일이나 gcloud 로그인 계정으로 쓴다."""
    from anthropic import AsyncAnthropicVertex
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.providers.anthropic import AnthropicProvider

    from .vertex import resolve_vertex_auth

    auth = resolve_vertex_auth(p)
    if not auth.project:
        raise ProviderError(
            "Vertex AI에서 Claude를 쓰려면 서비스 계정 키 파일이나 프로젝트 ID가 필요합니다 (API 키로는 안 됩니다)."
        )
    client = AsyncAnthropicVertex(project_id=auth.project, region=auth.location, credentials=auth.credentials)
    return AnthropicModel(model_name, provider=AnthropicProvider(anthropic_client=client))


def is_anthropic_model(p: ResolvedProvider, model_name: str) -> bool:
    return p.kind == "anthropic" or (p.kind == "vertex" and model_name.startswith("claude"))


def build_model_settings(
    ref: str,
    p: ResolvedProvider,
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    thinking: str = "default",
) -> dict[str, Any]:
    """제공자별 차이를 흡수한 모델 설정."""
    _, model_name = split_model_ref(ref)
    settings: dict[str, Any] = {}
    # Claude는 사고를 켠 요청에 온도를 함께 보내면 거절한다. 사고를 골랐으면 온도를 보내지 않는다.
    if is_anthropic_model(p, model_name) and thinking in ("low", "medium", "high"):
        temperature = None
    if temperature is not None:
        t = max(0.0, min(2.0, float(temperature)))
        if is_anthropic_model(p, model_name):
            t = min(t, 1.0)  # Claude는 온도 상한이 1.0
        settings["temperature"] = t
    if max_tokens:
        settings["max_tokens"] = int(max_tokens)
    if p.kind in ("google", "vertex") and not model_name.startswith("claude"):
        settings["google_safety_settings"] = _GOOGLE_SAFETY_OFF
    return settings
