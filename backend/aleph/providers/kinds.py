"""제공자 종류 정의 — 어떤 제공자를 붙일 수 있는지의 단일 출처.

새 제공자 종류를 추가하려면 여기에 `ProviderKind` 하나를 더하고,
`factory.build_model`과 `catalog.list_models`에 분기를 하나씩 넣는다.

`tested`는 "실제 호출로 동작을 확인했는가"다. 프론트는 False인 종류에
"실제 작동 테스트 안 됨" 표시를 붙인다. 검증을 마치면 여기 값만 바꾸면 된다.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class ExtraField:
    name: str
    label: str
    placeholder: str = ""
    env: str | None = None
    secret: bool = False     # 키처럼 다룬다 — 저장은 하되 화면으로 다시 내보내지 않는다
    multiline: bool = False  # 여러 줄 입력 (붙여넣기·파일 선택)


@dataclass(frozen=True)
class ProviderKind:
    id: str
    label: str
    group: str  # "direct" | "platform" | "aggregator" | "local" | "custom"
    needs_key: bool = True
    key_optional: bool = False
    env_key: str | None = None
    default_base_url: str | None = None
    base_url_editable: bool = False
    tested: bool = False
    note: str = ""
    key_url: str = ""
    extra: tuple[ExtraField, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return asdict(self)


KINDS: dict[str, ProviderKind] = {
    k.id: k
    for k in [
        ProviderKind(
            id="google",
            label="Google Gemini",
            group="direct",
            env_key="GOOGLE_API_KEY",
            tested=True,
            key_url="https://aistudio.google.com/apikey",
        ),
        ProviderKind(
            id="anthropic",
            label="Anthropic Claude",
            group="direct",
            env_key="ANTHROPIC_API_KEY",
            tested=True,
            key_url="https://console.anthropic.com/settings/keys",
        ),
        ProviderKind(
            id="vertex",
            label="Google Cloud Vertex AI",
            group="platform",
            key_optional=True,
            env_key="VERTEX_API_KEY",
            tested=True,
            note="서비스 계정 키(JSON)를 넣으면 됩니다. API 키(익스프레스 모드)나 gcloud 로그인 계정으로도 붙습니다.",
            extra=(
                ExtraField("credentials_json", "서비스 계정 키 (JSON)", secret=True, multiline=True),
                ExtraField("project", "프로젝트 ID (비우면 키 파일의 값)", "my-gcp-project", env="GOOGLE_CLOUD_PROJECT"),
                ExtraField("location", "리전", "global", env="GOOGLE_CLOUD_LOCATION"),
            ),
        ),
        ProviderKind(
            id="openai",
            label="OpenAI",
            group="direct",
            env_key="OPENAI_API_KEY",
            key_url="https://platform.openai.com/api-keys",
        ),
        ProviderKind(
            id="xai",
            label="xAI Grok",
            group="direct",
            env_key="XAI_API_KEY",
            default_base_url="https://api.x.ai/v1",
            key_url="https://console.x.ai",
        ),
        ProviderKind(
            id="deepseek",
            label="DeepSeek",
            group="direct",
            env_key="DEEPSEEK_API_KEY",
            default_base_url="https://api.deepseek.com",
            key_url="https://platform.deepseek.com/api_keys",
        ),
        ProviderKind(
            id="openrouter",
            label="OpenRouter",
            group="aggregator",
            env_key="OPENROUTER_API_KEY",
            default_base_url="https://openrouter.ai/api/v1",
            key_url="https://openrouter.ai/keys",
            note="여러 회사의 모델을 키 하나로 씁니다.",
        ),
        ProviderKind(
            id="ollama",
            label="Ollama (로컬)",
            group="local",
            needs_key=False,
            default_base_url="http://localhost:11434/v1",
            base_url_editable=True,
            note="이 컴퓨터에서 도는 모델. 도구 호출을 지원하는 모델이어야 에이전트로 쓸 수 있습니다.",
        ),
        ProviderKind(
            id="lmstudio",
            label="LM Studio (로컬)",
            group="local",
            needs_key=False,
            default_base_url="http://localhost:1234/v1",
            base_url_editable=True,
            note="이 컴퓨터에서 도는 모델. 도구 호출을 지원하는 모델이어야 에이전트로 쓸 수 있습니다.",
        ),
        ProviderKind(
            id="openai_compatible",
            label="OpenAI 호환 (직접 입력)",
            group="custom",
            key_optional=True,
            base_url_editable=True,
            note="OpenAI 형식 API를 제공하는 서버라면 주소만 넣어서 붙일 수 있습니다.",
        ),
    ]
}
