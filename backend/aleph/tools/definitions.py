"""사용자가 만드는 도구의 정의 — 도구 하나가 마크다운 파일 하나.

    ---
    name: compose             # 모델이 부르는 함수 이름 (영문). 비워 두면 저장할 때 정해진다
    label: 집필               # 화면에 보이는 이름. `/집필`의 그 이름
    description: 에이전트가 읽는 설명 (언제 쓰는지, 입력에 무엇을 준비해 두고 부르는지)
    model: anthropic:...      # 생략하면 프리셋의 보조 모델
    temperature: 0.9          # 생략하면 보조의 온도
    thinking: low             # 생략하면 보조의 추론 수준 (default | off | low | medium | high)
    max_tokens: 4000          # 최대 출력. 생략하면 보조의 최대 출력
    ---
    (여기부터 본문 = 지시문. 도구가 불렸을 때 모델이 따른다)

도구는 언제나 작업 공간의 '입력'을 읽고 결과를 '출력'에 쓴다. 도구가 보는 것은
자기 지시문과 입력뿐이다. 입력·출력의 자리를 도구마다 정하는 설정은 없다.
"""

from __future__ import annotations

import re

import yaml
from pydantic import BaseModel, field_validator

_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,48}$")
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)

# 에이전트의 기본 도구와 이름이 겹치면 안 된다.
RESERVED_NAMES = {
    "list", "read", "write", "edit", "delete", "move", "search", "set_note", "replace_all", "view_file",
    "web_search", "web_fetch", "image_generation",
    "insert_scene", "move_scene", "split", "merge_scenes", "ask_user",
    "set_summary", "summarize_scenes", "explore", "generate_image",
}


class ToolDefError(ValueError):
    pass


class ToolDef(BaseModel):
    name: str = ""
    label: str = ""
    description: str = ""
    prompt: str = ""
    # 아래 넷은 비우면 프리셋의 보조 값을 따른다.
    model: str = ""
    temperature: float | None = None
    thinking: str = ""          # "" | default | off | low | medium | high
    max_tokens: int | None = None
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            return ""   # 저장할 때 정해진다
        if not _NAME_RE.match(v):
            raise ValueError("도구의 영문 이름은 소문자로 시작하고 소문자·숫자·_ 만 쓸 수 있습니다 (2~49자).")
        if v in RESERVED_NAMES:
            raise ValueError(f"'{v}'는 기본 도구 이름이라 쓸 수 없습니다.")
        return v

    @field_validator("thinking", mode="before")
    @classmethod
    def _valid_thinking(cls, v: object) -> str:
        v = str(v or "").strip()
        return v if v in ("default", "off", "low", "medium", "high") else ""

    @property
    def title(self) -> str:
        return self.label.strip() or self.name


def assign_names(tools: list[ToolDef]) -> None:
    """영문 이름이 비어 있는 도구에 이름을 붙인다. 보이는 이름에 영문이 있으면 그것을 살린다."""
    taken = {t.name for t in tools if t.name}
    for t in tools:
        if t.name:
            continue
        base = re.sub(r"[^a-z0-9]+", "_", t.label.lower()).strip("_")
        if not base or not base[0].isalpha() or len(base) < 2 or base in RESERVED_NAMES:
            base = "tool"
        candidate = base if base != "tool" else "tool_1"
        n = 1
        while candidate in taken or candidate in RESERVED_NAMES:
            n += 1
            candidate = f"{base}_{n}"
        t.name = candidate[:49]
        taken.add(t.name)


def find_tool(tools: list[ToolDef], ref: str) -> ToolDef | None:
    """영문 이름이나 보이는 이름으로 도구를 찾는다."""
    key = (ref or "").strip().lstrip("/")
    return next((t for t in tools if t.name == key), None) or next((t for t in tools if t.label.strip() == key), None)


def parse_tool_markdown(text: str) -> ToolDef:
    """마크다운 + YAML 머리말을 ToolDef로 읽는다. 모르는 칸은 무시한다."""
    match = _FRONTMATTER_RE.match(text.replace("\r\n", "\n").strip() + "\n")
    if not match:
        raise ToolDefError("도구 파일은 '---'로 감싼 머리말(YAML)로 시작해야 합니다.")
    try:
        meta = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as e:
        raise ToolDefError(f"머리말(YAML)을 읽지 못했습니다: {e}") from e
    if not isinstance(meta, dict):
        raise ToolDefError("머리말은 '이름: 값' 꼴이어야 합니다.")
    fields = {k: meta[k] for k in ("name", "label", "description", "model", "temperature", "thinking", "max_tokens", "enabled") if k in meta}
    # 손으로 만든 파일의 이름이 기본 도구와 겹칠 수 있다. 그 이름은 버리고 읽는 쪽이 새로 붙인다.
    if str(fields.get("name") or "").strip() in RESERVED_NAMES:
        fields["name"] = ""
    try:
        return ToolDef(**fields, prompt=match.group(2).strip())
    except Exception as e:
        raise ToolDefError(str(e)) from e


def dump_tool_markdown(tool: ToolDef) -> str:
    meta: dict = {"name": tool.name, "label": tool.label, "description": tool.description}
    if tool.model:
        meta["model"] = tool.model
    if tool.temperature is not None:
        meta["temperature"] = tool.temperature
    if tool.thinking:
        meta["thinking"] = tool.thinking
    if tool.max_tokens is not None:
        meta["max_tokens"] = tool.max_tokens
    if not tool.enabled:
        meta["enabled"] = False
    head = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False, width=1000).strip()
    return f"---\n{head}\n---\n\n{tool.prompt.strip()}\n"


def usable_name(name: str) -> bool:
    """도구의 영문 이름으로 쓸 수 있는가 (파일 이름에서 이름을 짐작할 때 확인한다)."""
    return bool(_NAME_RE.match(name)) and name not in RESERVED_NAMES
