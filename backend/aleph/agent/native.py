"""제공자가 실행하는 도구 — 웹 검색, 웹 페이지 읽기.

우리 서버가 아니라 모델 제공자 쪽에서 도는 도구다. 프리셋에서 켜 두면, 지금 모델이
지원할 때만 붙는다. 지원하지 않는 모델에서는 조용히 빠진다 (오류로 실행을 막지 않는다).

  웹 검색         Claude, Gemini, OpenAI, OpenRouter
  웹 페이지 읽기  Claude, Gemini

예전 Gemini(2.5 이하)는 이런 도구와 우리가 준 도구를 한 요청에 같이 쓰지 못한다.
에이전트는 늘 우리 도구를 들고 있으므로, 그런 모델에서는 붙이지 않는다.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic_ai.capabilities import NativeTool
from pydantic_ai.native_tools import WebFetchTool, WebSearchTool

NATIVE_LABELS = {
    "web_search": "웹 검색",
    "web_fetch": "웹 페이지 읽기",
    "image_generation": "이미지 생성",
}

# 그림은 여기에 없다. 프리셋의 이미지 모델이 만든다 (tools/agent_tools.py의 generate_image).
_TOOLS = {"web_search": WebSearchTool, "web_fetch": WebFetchTool}


def supported_natives(model: Any) -> dict[str, bool]:
    """이 모델에서 쓸 수 있는 것."""
    profile = getattr(model, "profile", None) or {}
    supported = profile.get("supported_native_tools", frozenset())
    # Gemini 계열만 이 값을 갖는다. 없으면(다른 제공자) 같이 쓸 수 있는 것이다.
    combinable = profile.get("google_supports_tool_combination", True)
    return {name: bool(combinable and tool in supported) for name, tool in _TOOLS.items()}


def native_capabilities(preset: Any, model: Any) -> tuple[list[Any], set[str]]:
    """프리셋에서 켠 것 가운데 이 모델이 지원하는 것을 에이전트에 붙일 꼴로. (붙일 것, 붙은 것의 이름)"""
    can = supported_natives(model)
    wanted = {name for name in _TOOLS if getattr(preset, name, False)}
    names = {name for name in wanted if can[name]}
    return [NativeTool(_TOOLS[name]()) for name in sorted(names)], names


def native_note(names: set[str]) -> str:
    """에이전트에게 알려 줄 말."""
    lines = []
    if "web_search" in names:
        lines.append("웹 검색을 쓸 수 있습니다. 사실 확인이나 자료 조사가 필요할 때 씁니다.")
    if "web_fetch" in names:
        lines.append("주소를 주면 그 웹 페이지를 읽을 수 있습니다.")
    if names & {"web_search", "web_fetch"}:
        lines.append("찾은 것 가운데 남겨 둘 것은 출처(주소)와 함께 자료에 적으십시오. 대화에만 남기면 다음에 다시 찾아야 합니다.")
    return "<web>\n" + "\n".join(lines) + "\n</web>"


def native_args(tool: str, args: Any) -> dict:
    """제공자마다 다른 인자 이름을 화면이 읽는 이름으로 맞춘다: 검색어는 `query`, 주소는 `url`. 원래 값도 그대로 둔다."""
    out = dict(args) if isinstance(args, dict) else {"_raw": str(args)}

    def first(*keys: str) -> str:
        for key in keys:
            value = out.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, list) and value:
                texts = [str(v).strip() for v in value if isinstance(v, (str, int, float)) and str(v).strip()]
                if texts:
                    return ", ".join(texts)
        return ""

    if tool == "web_search" and not isinstance(out.get("query"), str):
        found = first("queries", "q", "search_query", "search_queries", "input")
        if found:
            out["query"] = found
    if tool == "web_fetch" and not isinstance(out.get("url"), str):
        found = first("urls", "uri", "link", "href")
        if found:
            out["url"] = found
    return out


_IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


def save_generated_image(docs: Any, content: Any, *, run_id: str = "") -> str | None:
    """모델이 만든 이미지를 자료/삽화에 저장하고 그 경로를 돌려준다. 이미지가 아니면 None."""
    media_type = str(getattr(content, "media_type", "") or "")
    data = getattr(content, "data", None)
    ext = _IMAGE_EXT.get(media_type)
    if ext is None or not isinstance(data, (bytes, bytearray)) or not data:
        return None
    return docs.save_file(f"자료/삽화/만든 그림{ext}", bytes(data), by="agent", run_id=run_id)


NO_RESULT = {
    "web_search": "제공자가 출처 목록을 돌려주지 않았습니다. 검색한 내용은 에이전트의 답에 반영되어 있습니다.",
    "web_fetch": "제공자가 읽은 내용을 따로 돌려주지 않았습니다.",
}


def native_result_text(tool: str, content: Any, limit: int = 1500) -> str:
    """제공자가 돌려준 결과를 화면에 보일 글로. 검색 결과면 제목과 주소를 한 줄씩. 아직 온 것이 없으면 빈 문자열."""
    if content is None or content == "" or content == [] or content == {}:
        return ""
    rows = content if isinstance(content, list) else None
    if isinstance(content, dict):
        for key in ("results", "content", "sources"):
            if isinstance(content.get(key), list):
                rows = content[key]
                break
    if rows and all(isinstance(r, dict) for r in rows):
        lines = []
        for r in rows[:10]:
            title = str(r.get("title") or r.get("name") or "").strip()
            url = str(r.get("url") or r.get("uri") or r.get("link") or "").strip()
            if title or url:
                lines.append(" — ".join(x for x in (title, url) if x))
        if lines:
            more = f"\n(외 {len(rows) - 10}건)" if len(rows) > 10 else ""
            return "\n".join(lines) + more
    if isinstance(content, str):
        text = content
    else:
        try:
            text = json.dumps(content, ensure_ascii=False, default=str)
        except Exception:
            text = str(content)
    return text if len(text) <= limit else text[:limit].rstrip() + "…"
