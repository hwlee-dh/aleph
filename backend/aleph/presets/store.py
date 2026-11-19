"""프리셋 저장소 — 프리셋 하나가 폴더 하나.

프리셋은 에이전트 지침, 모델 설정(에이전트와 보조), 도구 한 벌이다. 모델 설정은 여기에만 있다
(앱 설정에는 없다). 프리셋을 주고받으면 모델 설정도 같이 간다.

    <id>/
      preset.yaml         이름, 설명, 에이전트와 보조의 모델·온도·추론·한도, 도구 순서, 노트로 둘 시작 자료
      instruction.md      에이전트 지침
      tools/<name>.md     도구 (도구 하나 = 파일 하나)
      starter/…           새 작업에 깔 자료

기본 제공 프리셋은 `backend/presets/`에 있고 읽기 전용이다. 사용자가 고치면
같은 id로 `data/presets/`에 저장되어 기본 제공본을 가린다.
프리셋은 그것을 쓰는 모든 작업이 공유한다. 고치면 다음 요청부터 적용된다.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

from ..tools.definitions import (
    ToolDef,
    ToolDefError,
    assign_names,
    dump_tool_markdown,
    parse_tool_markdown,
    usable_name,
)
from ..workspace.documents import MATERIALS, DocError, normalize_path, zone_of

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

Mode = Literal["manual", "auto", "autonomous", "plan"]
Thinking = Literal["default", "off", "low", "medium", "high"]

# 요약 도구를 새로 넣을 때 채우는 글. 기본 프리셋의 `tools/summarize.md`와 같다.
SUMMARY_TOOL_NAME = "summarize"
SUMMARY_TOOL_LABEL = "요약"
SUMMARY_TOOL_DESCRIPTION = (
    "입력에 든 글을 한두 문장으로 요약합니다. 장면의 본문을 넣으면 그 장면의 요약이, "
    "한 장의 장면 요약들을 넣으면 그 장의 요약이 나옵니다."
)
SUMMARY_TOOL_PROMPT = """입력에 든 글을 요약한다.

입력이 소설의 장면이면 한두 문장으로 요약한다. 무슨 일이 일어나는지, 누가 무엇을 하는지, 이 장면으로 무엇이 달라지는지를 적는다.
입력이 한 장을 이루는 장면들의 요약 묶음이면 그 장 전체를 두세 문장으로 요약한다. 장에서 일어나는 일의 줄기와, 장이 끝날 때 달라져 있는 것을 적는다.

나중에 이 요약만 보고 그 자리를 다시 찾을 수 있어야 한다.
종결어미는 평서형('-한다', '-했다')으로 통일한다. 요약만 출력한다."""


def summary_tool() -> ToolDef:
    """요약 도구의 기본 꼴. 보통 도구다 (입력을 읽고 출력에 쓴다)."""
    return ToolDef(
        name=SUMMARY_TOOL_NAME, label=SUMMARY_TOOL_LABEL,
        description=SUMMARY_TOOL_DESCRIPTION, prompt=SUMMARY_TOOL_PROMPT,
    )


class PresetError(ValueError):
    pass


class Preset(BaseModel):
    id: str
    name: str = ""
    description: str = ""
    instruction: str = ""
    tools: list[ToolDef] = Field(default_factory=list)
    # 에이전트
    model: str = ""                    # '제공자:모델'. 비면 실행할 수 없다 (채팅창에서 고르면 여기에 적힌다)
    temperature: float | None = None   # None이면 모델의 기본값
    thinking: Thinking = "default"
    max_output_tokens: int | None = None
    context_budget: int = 150_000      # 대화가 이 토큰 수를 넘으면 앞부분을 줄인다
    # 보조: 도구가 따로 정하지 않았을 때 쓰는 값. 대화 압축도 이 모델로 한다.
    auxiliary_model: str = ""          # 비면 에이전트 모델과 같다
    auxiliary_temperature: float | None = None
    auxiliary_thinking: Thinking = "default"
    auxiliary_max_output_tokens: int | None = None
    auxiliary_max_input_tokens: int | None = None   # 도구에 넘기는 글이 이것을 넘으면 돌리지 않는다
    # 이미지: 그림을 만드는 모델. 에이전트 모델과 따로다 (그림을 만드는 모델은 보통 도구를 못 쓴다).
    # 정해 두면 에이전트가 `generate_image` 도구를 받는다. 비면 그 도구가 없다.
    image_model: str = ""
    # 이 프리셋으로 새 작업을 만들 때의 모드. 비면 앱의 기본값(자동)이다. 그 뒤에는 사용자가 채팅창에서 바꾼다.
    # 프리셋이 정하는 일하는 방식(혼자 끝까지 쓴다, 사용자가 쓰고 거든다)과 모드가 어긋나지 않게 하려는 것이다.
    start_mode: Mode | Literal[""] = ""
    starter: dict[str, str] = Field(default_factory=dict)   # 새 작업에 깔 자료 (경로 → 내용)
    starter_notes: list[str] = Field(default_factory=list)  # 그중 노트 옵션을 켜 둘 경로
    # 제공자가 실행하는 도구. 지금 모델이 지원할 때만 붙는다 (agent/native.py).
    web_search: bool = False
    web_fetch: bool = False
    builtin: bool = False              # 저장소가 채운다 (기본 제공본을 그대로 보고 있는지)

    def enabled_tools(self) -> list[ToolDef]:
        """에이전트에게 주고 `/도구`로 돌릴 수 있는 도구. 꺼 둔 것과 지시문이 아직 빈 것은 뺀다."""
        return [t for t in self.tools if t.enabled and t.name and t.prompt.strip()]


def _starter_path(path: str) -> str:
    """시작 자료의 경로를 '자료/…' 꼴로 맞춘다."""
    raw = path if zone_of(path) == "material" else f"{MATERIALS}/{path}"
    return normalize_path(raw)


class PresetStore:
    def __init__(self, builtin_dir: Path, user_dir: Path):
        self.builtin_dir = builtin_dir
        self.user_dir = user_dir

    # --- 조회 ---

    def _dirs(self) -> dict[str, tuple[Path, bool]]:
        found: dict[str, tuple[Path, bool]] = {}
        for base, is_builtin in ((self.builtin_dir, True), (self.user_dir, False)):
            if not base.exists():
                continue
            for d in sorted(base.iterdir()):
                if d.is_dir() and (d / "preset.yaml").exists():
                    found[d.name] = (d, is_builtin)  # 사용자본이 뒤에 와서 기본 제공본을 가린다
        return found

    def list(self) -> list[dict]:
        out = []
        for preset_id, (path, is_builtin) in self._dirs().items():
            try:
                meta = yaml.safe_load((path / "preset.yaml").read_text(encoding="utf-8")) or {}
            except Exception:
                continue
            out.append({
                "id": preset_id,
                "name": meta.get("name") or preset_id,
                "description": meta.get("description", ""),
                "builtin": is_builtin,
                "has_builtin": (self.builtin_dir / preset_id / "preset.yaml").exists(),
            })
        return out

    def get(self, preset_id: str) -> Preset | None:
        entry = self._dirs().get(preset_id)
        if entry is None:
            return None
        path, is_builtin = entry
        return self._read(path, preset_id, is_builtin)

    def first_id(self) -> str:
        """아무 프리셋도 정해지지 않았을 때 쓸 것."""
        ids = list(self._dirs())
        return "basic" if "basic" in ids else (ids[0] if ids else "")

    def _read(self, path: Path, preset_id: str, is_builtin: bool) -> Preset:
        files: dict[str, str] = {}
        for f in sorted(path.rglob("*")):
            if not f.is_file():
                continue
            try:
                files[f.relative_to(path).as_posix()] = f.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
        return preset_from_files(files, preset_id, is_builtin)

    # --- 저장/삭제 ---

    def save(self, preset: Preset) -> Preset:
        if not _ID_RE.match(preset.id):
            raise PresetError("프리셋 id는 영문·숫자·-·_ 만 쓸 수 있습니다 (64자 이내).")
        assign_names(preset.tools)
        # 화면은 고치는 족족 저장하므로, 쓰다 만 상태(지시문이 빈 도구, 이름이 같은 도구)도 받는다.
        # 지시문이 빈 도구는 에이전트에게 주지 않고 돌릴 수도 없다 (enabled_tools).
        seen: set[str] = set()
        for t in preset.tools:
            if t.name in seen:
                raise PresetError(f"도구의 영문 이름이 겹칩니다: {t.name}")
            seen.add(t.name)
        files = preset_files(preset)   # 시작 자료의 경로도 여기서 맞춰진다

        path = self.user_dir / preset.id
        for folder in ("tools", "starter"):
            if (path / folder).exists():
                shutil.rmtree(path / folder)
        (path / "tools").mkdir(parents=True, exist_ok=True)
        for rel, content in files.items():
            target = path / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        preset.builtin = False
        return preset

    def free_id(self, base: str) -> str:
        """아직 쓰이지 않은 id를 고른다. base가 비어 있으면 그대로, 아니면 뒤에 번호를 붙인다."""
        stem = re.sub(r"[^A-Za-z0-9_-]+", "_", base or "").strip("_-")[:56] or "preset"
        taken = set(self._dirs())
        if stem not in taken:
            return stem
        n = 2
        while f"{stem}_{n}" in taken:
            n += 1
        return f"{stem}_{n}"

    def duplicate(self, preset_id: str, name: str = "") -> Preset | None:
        """프리셋을 새 id로 복제한다."""
        source = self.get(preset_id)
        if source is None:
            return None
        copy = source.model_copy(deep=True)
        copy.id = self.free_id(f"{preset_id}_copy")
        copy.name = name.strip() or self.free_name(f"{source.name} 사본")
        return self.save(copy)

    def free_name(self, base: str) -> str:
        """아직 쓰이지 않은 이름. 같은 이름이 있으면 뒤에 번호를 붙인다."""
        taken = {p["name"] for p in self.list()}
        if base not in taken:
            return base
        n = 2
        while f"{base} {n}" in taken:
            n += 1
        return f"{base} {n}"

    def import_files(self, files: dict[str, str], preset_id: str = "", keep_name: bool = False) -> Preset:
        """내보낸 프리셋(`preset_files`의 모양)을 새 id로 들여온다. 있던 것을 덮어쓰지 않는다.

        같은 이름이 이미 있으면 뒤에 번호를 붙인다 (keep_name이면 그대로 둔다).
        """
        if "preset.yaml" not in files:
            raise PresetError("프리셋 파일이 아닙니다 (preset.yaml이 없습니다).")
        base = self.free_id(preset_id or "imported")
        try:
            preset = preset_from_files(files, base)
        except PresetError:
            raise
        except Exception as e:
            raise PresetError(f"프리셋 파일을 읽지 못했습니다: {e}") from e
        clamp(preset)
        if not keep_name:
            preset.name = self.free_name(preset.name)
        return self.save(preset)

    def delete(self, preset_id: str) -> str:
        """사용자본을 지운다. 반환: 'deleted' | 'reverted'(기본 제공본으로 복귀) | 'readonly' | 'missing'."""
        if not _ID_RE.match(preset_id):
            return "missing"
        user_path = self.user_dir / preset_id
        has_builtin = (self.builtin_dir / preset_id / "preset.yaml").exists()
        if user_path.exists():
            shutil.rmtree(user_path)
            return "reverted" if has_builtin else "deleted"
        return "readonly" if has_builtin else "missing"


def clamp(preset: Preset) -> Preset:
    """숫자 칸을 쓸 수 있는 범위로 맞춘다. 0이나 음수인 한도는 "정하지 않음"으로 본다."""
    for key in ("temperature", "auxiliary_temperature"):
        value = getattr(preset, key)
        if value is not None:
            setattr(preset, key, max(0.0, min(2.0, float(value))))
    for key in ("max_output_tokens", "auxiliary_max_output_tokens", "auxiliary_max_input_tokens"):
        value = getattr(preset, key)
        if value is not None and value <= 0:
            setattr(preset, key, None)
    preset.context_budget = max(0, int(preset.context_budget))
    for t in preset.tools:
        if t.temperature is not None:
            t.temperature = max(0.0, min(2.0, float(t.temperature)))
        if t.max_tokens is not None and t.max_tokens <= 0:
            t.max_tokens = None
    return preset


def preset_files(preset: Preset) -> dict[str, str]:
    """프리셋을 파일들로 편다 (상대 경로 → 내용). 저장소의 폴더와 `.alephpreset` 안의 모양이 이것이다.

    시작 자료의 경로를 '자료/…' 꼴로 맞춰 preset에 되돌려 적는다.
    """
    try:
        starter = {_starter_path(p): c for p, c in preset.starter.items()}
        notes = [_starter_path(p) for p in preset.starter_notes]
    except DocError as e:
        raise PresetError(f"시작 자료의 경로가 올바르지 않습니다: {e}") from e
    preset.starter, preset.starter_notes = starter, notes
    meta = {
        "name": preset.name or preset.id,
        "description": preset.description,
        "model": preset.model,
        "temperature": preset.temperature,
        "thinking": preset.thinking,
        "max_output_tokens": preset.max_output_tokens,
        "context_budget": preset.context_budget,
        "auxiliary_model": preset.auxiliary_model,
        "auxiliary_temperature": preset.auxiliary_temperature,
        "auxiliary_thinking": preset.auxiliary_thinking,
        "auxiliary_max_output_tokens": preset.auxiliary_max_output_tokens,
        "auxiliary_max_input_tokens": preset.auxiliary_max_input_tokens,
        "image_model": preset.image_model,
        "start_mode": preset.start_mode,
        "tool_order": [t.name for t in preset.tools],
        "starter_notes": [p[len(MATERIALS) + 1:] for p in notes],
        "web_search": preset.web_search,
        "web_fetch": preset.web_fetch,
    }
    files = {
        "preset.yaml": yaml.safe_dump(meta, allow_unicode=True, sort_keys=False),
        "instruction.md": preset.instruction,
    }
    for t in preset.tools:
        files[f"tools/{t.name}.md"] = dump_tool_markdown(t)
    for doc_path, content in starter.items():
        files[f"starter/{doc_path[len(MATERIALS) + 1:]}"] = content
    return files


def preset_from_files(files: dict[str, str], preset_id: str, is_builtin: bool = False) -> Preset:
    """`preset_files`의 반대. 파일들(상대 경로 → 내용)에서 프리셋을 읽는다."""
    meta = yaml.safe_load(files.get("preset.yaml", "")) or {}
    if not isinstance(meta, dict):
        raise PresetError(f"프리셋 '{preset_id}'의 preset.yaml은 '이름: 값' 꼴이어야 합니다.")
    tool_files = {
        p[len("tools/"):-len(".md")]: text
        for p, text in files.items()
        if p.startswith("tools/") and p.endswith(".md") and p.count("/") == 1
    }
    order = [str(n) for n in meta.get("tool_order") or []]
    tools: list[ToolDef] = []
    for name in [n for n in order if n in tool_files] + sorted(n for n in tool_files if n not in order):
        try:
            tool = parse_tool_markdown(tool_files[name])
            if not tool.name and usable_name(name):   # 아니면 비워 두고 저장할 때 정한다
                tool.name = name
        except (ToolDefError, ValueError) as e:
            raise PresetError(f"프리셋 '{preset_id}'의 도구 파일 {name}.md: {e}") from e
        tools.append(tool)
    assign_names(tools)   # 이름이 빈 도구(손으로 만든 파일, 기본 도구와 이름이 겹쳐 버린 것)에 이름을 붙인다

    starter: dict[str, str] = {}
    for p, text in sorted(files.items()):
        if p.startswith("starter/"):
            try:
                starter[_starter_path(p[len("starter/"):])] = text
            except DocError:
                continue
    notes: list[str] = []
    for p in meta.get("starter_notes") or []:
        try:
            notes.append(_starter_path(str(p)))
        except DocError:
            continue

    def number(key: str) -> float | None:
        value = meta.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    def whole(key: str) -> int | None:
        value = number(key)
        return int(value) if value and value > 0 else None

    def level(key: str) -> str:
        value = meta.get(key, "default")
        return value if value in ("default", "off", "low", "medium", "high") else "default"

    budget = number("context_budget")
    return Preset(
        id=preset_id,
        name=str(meta.get("name") or preset_id),
        description=str(meta.get("description") or ""),
        instruction=files.get("instruction.md", ""),
        tools=tools,
        model=str(meta.get("model") or ""),
        temperature=number("temperature"),
        thinking=level("thinking"),
        max_output_tokens=whole("max_output_tokens"),
        context_budget=int(budget) if budget is not None and budget >= 0 else 150_000,
        auxiliary_model=str(meta.get("auxiliary_model") or ""),
        auxiliary_temperature=number("auxiliary_temperature"),
        auxiliary_thinking=level("auxiliary_thinking"),
        auxiliary_max_output_tokens=whole("auxiliary_max_output_tokens"),
        auxiliary_max_input_tokens=whole("auxiliary_max_input_tokens"),
        image_model=str(meta.get("image_model") or ""),
        start_mode=meta.get("start_mode") if meta.get("start_mode") in ("manual", "auto", "autonomous", "plan") else "",
        starter=starter,
        starter_notes=notes,
        web_search=bool(meta.get("web_search")),
        web_fetch=bool(meta.get("web_fetch")),
        builtin=is_builtin,
    )
