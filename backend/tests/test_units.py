"""부품 단위 — 도구 정의, 이력 정리, 맥락 압축, 작업 공간 경로."""

from __future__ import annotations

import pytest
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from aleph.agent import compaction
from aleph.agent.history import sanitize_history
from aleph.tools.definitions import (
    ToolDef,
    ToolDefError,
    assign_names,
    dump_tool_markdown,
    find_tool,
    parse_tool_markdown,
)
from tests.conftest import results, run, scripted, test_preset

TOOL_MD = """---
name: check_continuity
label: 연속성 점검
description: 입력에 든 장이 자료와 어긋나는지 본다.
model: anthropic:claude-x
temperature: 0.3
---

너는 교열자다.
"""


def test_tool_markdown_roundtrip():
    tool = parse_tool_markdown(TOOL_MD)
    assert tool.name == "check_continuity" and tool.title == "연속성 점검" and tool.temperature == 0.3
    assert tool.prompt == "너는 교열자다." and tool.enabled
    assert parse_tool_markdown(dump_tool_markdown(tool)) == tool
    # 모르는 칸은 읽을 때 버린다
    extra = parse_tool_markdown("---\nname: my_tool\nauthor: 누구\ntags:\n  - 초안\n---\n지시문")
    assert extra.name == "my_tool" and extra.prompt == "지시문"


@pytest.mark.parametrize("text, message", [
    ("그냥 글", "머리말"),
    ("---\nname: Read It\n---\nx", "영문 이름"),
])
def test_tool_markdown_errors(text, message):
    with pytest.raises(ToolDefError, match=message):
        parse_tool_markdown(text)


def test_a_tool_file_named_like_a_builtin_is_renamed_not_rejected():
    """손으로 만든 도구 파일의 이름이 기본 도구(explore 등)와 겹쳐도 프리셋은 읽힌다. 이름만 새로 붙는다."""
    from aleph.presets.store import preset_from_files

    assert parse_tool_markdown("---\nname: read\nlabel: 읽기 도우미\n---\nx").name == ""
    with pytest.raises(ValueError, match="기본 도구 이름"):
        ToolDef(name="explore", prompt="x")                              # 화면에서 만들 때는 막는다
    preset = preset_from_files({
        "preset.yaml": "name: 손으로 만든 것\ntool_order: [explore, compose]\n",
        "tools/explore.md": "---\nname: explore\nlabel: Explore 자료\n---\n자료를 훑는다.\n",
        "tools/compose.md": "---\nname: compose\nlabel: 집필\n---\n쓴다.\n",
    }, "hand")
    assert [(t.name, t.label) for t in preset.tools] == [("tool_1", "Explore 자료"), ("compose", "집필")]


def test_tool_names_are_assigned():
    tools = [ToolDef(label="집필", prompt="p"), ToolDef(label="Outline 짜기", prompt="p"), ToolDef(label="비평", prompt="p")]
    assign_names(tools)
    assert [t.name for t in tools] == ["tool_1", "outline", "tool_2"]
    assert find_tool(tools, "/집필") is tools[0] and find_tool(tools, "outline") is tools[1] and find_tool(tools, "없음") is None


def _call(name: str, cid: str) -> ModelResponse:
    return ModelResponse(parts=[ToolCallPart(tool_name=name, args={}, tool_call_id=cid)])


def _ret(name: str, cid: str) -> ModelRequest:
    return ModelRequest(parts=[ToolReturnPart(tool_name=name, content="ok", tool_call_id=cid)])


def test_sanitize_history_drops_dangling_pieces():
    user = ModelRequest(parts=[UserPromptPart(content="써줘")])
    answer = ModelResponse(parts=[TextPart(content="알겠다")])
    assert sanitize_history([user, answer]) == [user, answer]
    # 결과 없는 도구 호출
    assert sanitize_history([user, answer, user, _call("read", "1")]) == [user, answer]
    # 짝이 맞는 호출은 남고, 그 뒤의 끊긴 호출만 잘린다
    kept = sanitize_history([user, _call("read", "1"), _ret("read", "1"), _call("write", "2")])
    assert len(kept) == 3
    # 다른 호출의 결과가 와 있으면 짝이 아니다
    assert sanitize_history([user, _call("read", "1"), _ret("read", "zzz")]) == []
    # 답을 못 받은 사용자 요청은 쌓이지 않는다
    assert sanitize_history([user, answer, user]) == [user, answer]


async def test_compaction_during_run(ctx, models, work):
    big = "가 " * 3000  # 가짜 모델은 낱말 수로 토큰을 센다
    # 압축이 대화를 줄이므로, 이 대본은 대화 길이가 아니라 호출 횟수로 진행한다.
    models("test:agent", scripted([
        {"tool": "write", "args": {"path": "자료/긴 글", "content": big}},
        {"tool": "read", "args": {"path": "자료/긴 글"}},
        {"tool": "read", "args": {"path": "자료/긴 글"}},
        {"tool": "read", "args": {"path": "자료/긴 글"}},
        {"tool": "read", "args": {"path": "자료/긴 글"}},
        "다 읽었다.",
    ]))
    sid = work(context_budget=2500)                     # 한도는 프리셋의 것이다
    models("test:aux", ["긴 글을 쓰고 여러 번 읽었다."])
    events = await run(ctx, sid, "긴 글을 준비해줘")
    assert events[-1]["status"] == "completed"
    compactions = [e for e in events if e["type"] == "compaction"]
    # 읽어 온 글이 대부분이라, 요약하지 않고 오래된 도구 결과를 비우는 것으로 끝난다 (보조 모델을 부르지 않는다)
    assert compactions and {c["kind"] for c in compactions} == {"cleared"} and compactions[0]["cleared_results"] == 1
    assert compactions[0]["tokens_after"] < compactions[0]["tokens_before"]
    assert not [c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "[compaction]"]
    # 압축 후에도 도구 호출/결과의 짝은 깨지지 않아 실행이 끝까지 갔다
    assert sum(1 for e in events if e["type"] == "tool_result") == 5
    assert events[-1]["usage"]["context_tokens"] > 0

    # 비울 도구 결과가 없으면(에이전트가 직접 쓴 긴 글) 앞부분을 보조 모델로 요약한다
    models("test:agent", scripted([
        {"tool": "write", "args": {"path": f"자료/긴 글 {n}", "content": big}} for n in range(4)
    ] + ["다 썼다."]))
    events = await run(ctx, sid, "긴 글을 몇 편 더 써줘")
    summaries = [e for e in events if e["type"] == "compaction" and e["kind"] == "summary"]
    assert events[-1]["status"] == "completed" and summaries and summaries[0]["summary"] == "긴 글을 쓰고 여러 번 읽었다."
    assert summaries[0]["dropped_messages"] > 0 and summaries[0]["tokens_after"] < summaries[0]["tokens_before"]
    assert [c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "[compaction]"]

    # 자동 압축을 꺼 두면 한도를 넘어도 줄이지 않는다
    models("test:agent", scripted([{"tool": "read", "args": {"path": "자료/긴 글"}}] * 3 + ["다 읽었다."]))
    ctx.set_state(sid, auto_compact=False)
    events = await run(ctx, sid, "다시 읽어줘")
    assert events[-1]["status"] == "completed" and not [e for e in events if e["type"] == "compaction"]


@pytest.mark.parametrize("thinking", ["default", "off", "low", "high"])
async def test_thinking_settings_do_not_break_a_run(ctx, models, work, thinking):
    models("test:agent", ["알겠다."])
    sid = work(thinking=thinking)
    events = await run(ctx, sid, "확인")
    assert events[-1]["status"] == "completed", [e for e in events if e["type"] == "error"]


def test_native_tools_depend_on_the_model():
    """제공자가 실행하는 도구는 모델이 지원할 때만 붙는다. 예전 Gemini는 우리 도구와 같이 쓰지 못한다."""
    from pydantic_ai.native_tools import ImageGenerationTool, WebFetchTool, WebSearchTool

    from aleph.agent.native import native_capabilities, native_note, native_result_text, supported_natives

    class Model:
        def __init__(self, **profile):
            self.profile = profile

    everything = frozenset({WebSearchTool, WebFetchTool, ImageGenerationTool})
    assert supported_natives(Model(supported_native_tools=everything)) == {"web_search": True, "web_fetch": True}
    assert supported_natives(Model(supported_native_tools=frozenset({WebSearchTool}))) == {"web_search": True, "web_fetch": False}
    old_gemini = Model(supported_native_tools=everything, google_supports_tool_combination=False)
    assert not any(supported_natives(old_gemini).values())
    assert not any(supported_natives(Model()).values())                      # 아무것도 모르는 모델(로컬 등)

    preset = test_preset(web_search=True, web_fetch=True)
    caps, names = native_capabilities(preset, Model(supported_native_tools=frozenset({WebSearchTool})))
    assert names == {"web_search"} and len(caps) == 1                         # 켜 두었어도 지원하는 것만 붙는다
    assert native_capabilities(test_preset(), Model(supported_native_tools=everything)) == ([], set())
    assert "웹 검색을 쓸 수 있습니다" in native_note({"web_search"}) and "출처" in native_note({"web_search"})

    # 제공자마다 다른 인자 이름을 화면이 읽는 이름으로 맞춘다
    from aleph.agent.native import native_args

    assert native_args("web_search", {"query": "등대"}) == {"query": "등대"}
    assert native_args("web_search", {"queries": ["등대 구조", "등대지기"]})["query"] == "등대 구조, 등대지기"
    assert native_args("web_fetch", {"urls": ["https://example.org/a"]})["url"] == "https://example.org/a"
    assert native_args("web_search", "이상한 값") == {"_raw": "이상한 값"}

    rows = [{"title": "등대의 역사", "url": "https://example.org/a"}, {"title": "", "uri": "https://example.org/b"}]
    assert native_result_text("web_search", rows) == "등대의 역사 — https://example.org/a\nhttps://example.org/b"
    assert native_result_text("web_search", {"results": rows[:1]}) == "등대의 역사 — https://example.org/a"
    assert native_result_text("web_fetch", "가" * 2000).endswith("…") and len(native_result_text("web_fetch", "가" * 2000)) == 1501


def test_generated_images_are_saved_to_materials(tmp_path):
    from pydantic_ai.messages import BinaryContent

    from aleph.agent.loop import steer_message
    from aleph.agent.native import save_generated_image
    from aleph.workspace.documents import DocWorkspace

    docs = DocWorkspace(tmp_path)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 8
    first = save_generated_image(docs, BinaryContent(data=png, media_type="image/png"))
    second = save_generated_image(docs, BinaryContent(data=png, media_type="image/jpeg"))
    again = save_generated_image(docs, BinaryContent(data=png, media_type="image/png"))
    assert (first, second, again) == ("자료/삽화/만든 그림.png", "자료/삽화/만든 그림.jpg", "자료/삽화/만든 그림 2.png")
    assert docs.get_bytes(first) == png and docs.history(first)[0]["by"] == "agent"
    assert save_generated_image(docs, BinaryContent(data=b"%PDF", media_type="application/pdf")) is None   # 이미지만 받는다

    # 저장된 자리는 에이전트에게 알림으로 전해진다 (사용자가 보낸 말과 구분해서)
    assert steer_message([], ["이미지는 '자료/삽화/만든 그림.png'에 저장되었습니다."]) == "[앱의 알림]\n이미지는 '자료/삽화/만든 그림.png'에 저장되었습니다."
    # 대화 기억에는 만든 이미지 자체를 남기지 않는다
    from pydantic_ai.messages import FilePart

    from aleph.agent.history import strip_files

    kept = strip_files([ModelResponse(parts=[TextPart(content="그렸다."), FilePart(content=BinaryContent(data=png, media_type="image/png"))])])
    assert [type(p).__name__ for p in kept[0].parts] == ["TextPart", "TextPart"] and "자료에 저장" in kept[0].parts[1].content
    both = steer_message(["더 어둡게"], ["알림"])
    assert both.startswith("[앱의 알림]\n알림\n\n[사용자가 실행 중에 보낸 말입니다.") and both.endswith("더 어둡게")


async def test_web_search_shows_up_as_a_tool_call(ctx, work):
    from pydantic_ai.messages import ModelResponse, NativeToolCallPart, NativeToolReturnPart, TextPart
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.native_tools import WebSearchTool

    from aleph.providers.factory import register_test_model

    offered: list[list[str]] = []
    given: list[set[str]] = []
    instructions: list[str] = []

    def answer(messages, info):
        offered.append(sorted(t.kind for t in info.model_request_parameters.native_tools))
        given.append({t.name for t in info.function_tools})
        instructions.append(info.instructions or "")
        return ModelResponse(parts=[TextPart(content="알겠다.")])

    async def stream(messages, info):
        offered.append(sorted(t.kind for t in info.model_request_parameters.native_tools))
        given.append({t.name for t in info.function_tools})
        instructions.append(info.instructions or "")
        if any(isinstance(t, WebSearchTool) for t in info.model_request_parameters.native_tools):
            yield {0: NativeToolCallPart(tool_name="web_search", args={"query": "1930년대 등대 구조"}, tool_call_id="w1")}
            yield {1: NativeToolReturnPart(tool_name="web_search", content=[{"title": "등대의 역사", "url": "https://example.org/a"}], tool_call_id="w1")}
        yield "찾아봤다."

    register_test_model("test:agent", FunctionModel(answer, stream_function=stream))
    sid = work("plan", preset=test_preset(id="searcher", web_search=True))    # 읽기이므로 계획 모드에서도 된다
    events = await run(ctx, sid, "그 시대 등대가 어떻게 생겼는지 찾아봐")
    assert events[-1]["status"] == "completed" and offered[0] == ["web_search"]
    assert "<web>" in instructions[0] and "웹 검색을 쓸 수 있습니다" in instructions[0]
    call = next(e for e in events if e["type"] == "tool_call")
    assert (call["tool"], call["label"], call["native"], call["args"]) == ("web_search", "웹 검색", True, {"query": "1930년대 등대 구조"})
    result = next(e for e in events if e["type"] == "tool_result")
    assert (result["native"], result["result"], result["ok"]) == (True, "등대의 역사 — https://example.org/a", True)
    assert events[-1]["total_tool_calls"] == 0                                # 제공자가 실행한 것은 도구 호출 수에 세지 않는다

    offered.clear()
    instructions.clear()
    plain = test_preset(id="plain")                                           # 꺼 두면 붙지 않는다
    plain.tools += [ToolDef(name="draft", label="쓰다 만 도구"), ToolDef(name="off", label="꺼 둔 도구", prompt="p", enabled=False)]
    sid = work("auto", preset=plain)
    await run(ctx, sid, "찾아봐")
    assert offered[0] == [] and "<web>" not in instructions[0]
    assert "compose" in given[-1] and not given[-1] & {"draft", "off"}        # 지시문이 빈 도구와 꺼 둔 도구는 에이전트에게 주지 않는다


def test_errors_are_worded_for_people():
    from aleph.agent.loop import friendly_error

    class ModelConnectionError(Exception):
        pass

    class RateLimitError(Exception):
        status_code = 429

    assert friendly_error(ModelConnectionError("Connection error.")) == (
        "제공자에 연결하지 못했습니다. 인터넷 연결과 제공자의 주소를 확인해야 합니다. (Connection error.)"
    )
    assert friendly_error(RateLimitError("slow down")).startswith("제공자의 사용량 한도에 걸렸습니다.")
    assert friendly_error(ValueError("이상한 값")) == "모델을 부르다가 문제가 생겼습니다. (ValueError: 이상한 값)"


def test_vertex_service_account_key_file(tmp_path, monkeypatch):
    """Vertex는 서비스 계정 키 파일(JSON)로 붙는 게 기본이다. 네트워크 없이 조립까지만 본다."""
    import json

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    from aleph.providers.factory import build_model
    from aleph.providers.store import ProviderConfig, ProviderError, ProviderStore
    from aleph.providers.vertex import resolve_vertex_auth

    for name in ("VERTEX_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"):
        monkeypatch.delenv(name, raising=False)
    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    key_file = tmp_path / "sa.json"
    key_file.write_text(json.dumps({
        "type": "service_account",
        "project_id": "my-proj-1234",
        "private_key_id": "abc",
        "private_key": pem,
        "client_email": "aleph@my-proj-1234.iam.gserviceaccount.com",
        "client_id": "1",
        "token_uri": "https://oauth2.googleapis.com/token",
    }), encoding="utf-8")

    store = ProviderStore(tmp_path / "config")
    store.upsert(ProviderConfig(id="vertex", kind="vertex"))
    assert store.public(store.get("vertex"))["ready"] is False       # 아무것도 안 넣었으면 못 쓴다

    # 화면에서 붙여 넣거나 파일을 골라 넣으면 JSON 내용이 그대로 저장된다
    store.upsert(ProviderConfig(id="vertex", kind="vertex", extra={"credentials_json": key_file.read_text(encoding="utf-8")}))
    public = store.public(store.get("vertex"))
    assert public["ready"] is True
    assert public["secrets"]["credentials_json"] == {
        "set": True,
        "summary": "aleph@my-proj-1234.iam.gserviceaccount.com · 프로젝트 my-proj-1234",
    }
    assert "credentials_json" not in public["extra"] and "PRIVATE KEY" not in json.dumps(public)
    # 다른 값만 고쳐 저장해도 키는 유지된다
    store.upsert(ProviderConfig(id="vertex", kind="vertex", extra={"location": "us-central1"}))
    assert store.public(store.get("vertex"))["secrets"]["credentials_json"]["set"] is True
    with pytest.raises(ProviderError, match="서비스 계정 키가 아닙니다"):
        store.upsert(ProviderConfig(id="vertex", kind="vertex", extra={"credentials_json": '{"type": "authorized_user"}'}))
    with pytest.raises(ProviderError, match="JSON 형식이 아닙니다"):
        store.upsert(ProviderConfig(id="vertex", kind="vertex", extra={"credentials_json": "C:/keys/sa.json"}))
    store.upsert(ProviderConfig(id="vertex", kind="vertex", extra={"location": "global"}))
    auth = resolve_vertex_auth(store.resolve("vertex"))
    assert auth.project == "my-proj-1234" and auth.location == "global" and auth.credentials is not None
    assert set(auth.genai_kwargs()) == {"project", "location", "credentials"}

    gemini, _ = build_model("vertex:gemini-x", store)
    claude, _ = build_model("vertex:claude-x", store)
    assert type(gemini).__name__ == "GoogleModel" and type(claude).__name__ == "AnthropicModel"

    # 저장된 키를 지우면 못 쓰는 상태로 돌아간다
    store.clear_key("vertex")
    assert store.public(store.get("vertex"))["ready"] is False

    # .env의 GOOGLE_APPLICATION_CREDENTIALS에 파일 경로를 적어 둔 경우도 된다
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(key_file))
    assert store.public(store.get("vertex"))["ready"] is True
    assert resolve_vertex_auth(store.resolve("vertex")).project == "my-proj-1234"

    # 잘못된 경로와 엉뚱한 JSON은 읽을 수 있는 말로 거절한다
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(tmp_path / "없는파일.json"))
    with pytest.raises(ProviderError, match="찾을 수 없습니다"):
        build_model("vertex:gemini-x", store)
    other = tmp_path / "other.json"
    other.write_text('{"type": "authorized_user"}', encoding="utf-8")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(other))
    with pytest.raises(ProviderError, match="서비스 계정 키가 아닙니다"):
        build_model("vertex:gemini-x", store)


def test_a_gemini_chosen_as_the_image_model_makes_images_whatever_its_name(tmp_path):
    """라이브러리는 이름에 'image'가 있어야 그림 모델로 본다. 이미지 모델로 고른 것은 이름이 달라도 그림을 내게 한다."""
    from pydantic_ai.native_tools import ImageGenerationTool

    from aleph.providers.factory import build_model
    from aleph.providers.store import ProviderConfig, ProviderStore

    store = ProviderStore(tmp_path / "config")
    store.upsert(ProviderConfig(id="google", kind="google", api_key="k"))

    def can(ref: str, *, image: bool) -> tuple[bool, bool]:
        profile = build_model(ref, store, image=image)[0].profile
        return bool(profile.get("supports_image_output")), ImageGenerationTool in profile.get("supported_native_tools", ())

    assert can("google:nano-banana-pro-preview", image=False) == (False, False)   # 글 모델로 쓸 때는 그대로
    assert can("google:nano-banana-pro-preview", image=True) == (True, True)
    assert can("google:gemini-nano-banana-2.1", image=True) == (True, True)
    assert can("google:gemini-2.5-flash-image", image=True) == (True, True)       # 이름으로 알아보는 모델은 손대지 않는다
    named = build_model("google:gemini-2.5-flash-image", store, image=True)[0]
    assert named._profile is None


def test_the_sdk_afc_warning_is_kept_off_the_console(caplog):
    """구글 SDK의 AFC 경고는 해가 없는데 실행마다 찍힌다. 그 한 줄만 거르고 다른 경고는 남긴다."""
    import logging

    import aleph.providers.factory  # noqa: F401  (거르개는 이 모듈을 읽을 때 붙는다)
    from google.genai import _extra_utils
    from google.genai import types as genai_types

    logger = logging.getLogger("google_genai.models")
    caplog.set_level(logging.WARNING, logger="google_genai.models")
    search = genai_types.Tool(google_search=genai_types.GoogleSearch())
    _extra_utils.log_afc_incompatible_tools_warning(genai_types.GenerateContentConfig(tools=[search, search]), [0])
    logger.warning("다른 경고")
    assert [r.getMessage() for r in caplog.records] == ["다른 경고"]


def test_claude_with_thinking_sends_no_temperature():
    """Claude는 사고를 켠 요청에 온도가 같이 오면 거절한다. 다른 제공자는 그대로 보낸다."""
    from aleph.providers.factory import build_model_settings
    from aleph.providers.store import ResolvedProvider

    def provider(kind: str) -> ResolvedProvider:
        return ResolvedProvider(id=kind, kind=kind, label=kind, api_key="k", base_url="", extra={})

    claude, gemini = provider("anthropic"), provider("google")
    assert build_model_settings("anthropic:claude-x", claude, temperature=0.8, thinking="default") == {"temperature": 0.8}
    assert build_model_settings("anthropic:claude-x", claude, temperature=1.4, thinking="off") == {"temperature": 1.0}
    assert build_model_settings("anthropic:claude-x", claude, temperature=0.8, thinking="high") == {}
    assert build_model_settings("vertex:claude-x", provider("vertex"), temperature=0.8, thinking="low") == {}
    assert build_model_settings("google:gemini-x", gemini, temperature=0.8, thinking="high")["temperature"] == 0.8


# ------------------------------------------------------------------ 대화 압축의 두 단계

def _say(text: str) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)])


def _ask(text: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)])


def _result(name: str, cid: str, content: str) -> ModelRequest:
    return ModelRequest(parts=[ToolReturnPart(tool_name=name, content=content, tool_call_id=cid)])


async def test_compaction_clears_old_tool_results_before_summarizing():
    async def never(prompt: str) -> str:
        raise AssertionError("요약할 일이 아니다")

    messages = [
        _ask("자료를 다 읽어줘"), _call("read", "1"), _result("read", "1", "가" * 8000),
        _call("read", "2"), _result("read", "2", "나" * 8000), _call("read", "3"), _result("read", "3", "짧다"), _say("다 읽었다."),
    ]
    assert await compaction.compact_messages(messages, 20_000, summarize=never) == (messages, None)   # 한도 아래면 그대로

    out, info = await compaction.compact_messages(messages, 6000, summarize=never)
    assert (info["kind"], info["cleared_results"], info["summary"]) == ("cleared", 1, "")
    assert info["tokens_after"] < 6000 * 0.7 < info["tokens_before"]
    assert len(out) == len(messages) and out[2].parts[0].content == compaction.CLEARED   # 오래된 결과만 비웠다
    assert out[4].parts[0].content == "나" * 8000 and out[0] is messages[0]               # 최근 것과 대화의 흐름은 그대로
    assert messages[2].parts[0].content == "가" * 8000                                    # 원래 목록은 건드리지 않는다
    assert sanitize_history(out) == out                                                   # 호출과 결과의 짝이 깨지지 않았다


async def test_compaction_summary_keeps_the_users_words_and_the_earlier_summary():
    seen: list[str] = []

    async def summarize(prompt: str) -> str:
        seen.append(prompt)
        return "새 요약"

    first = [
        _ask("등대지기 딸의 이야기를 쓰자. 시점은 서윤이야."), _say("가" * 6000),
        _ask("문체는 건조하게 해줘."), _say("나" * 6000),
        _ask("다음 장면을 써줘"), _call("read", "1"), _result("read", "1", "본문"), _say("썼다."),
    ]
    out, info = await compaction.compact_messages(first, 4000, summarize=summarize, goal="다음 장면을 써줘")
    note = out[0].parts[0].content
    assert info["kind"] == "summary" and info["dropped_messages"] == 3 and info["tokens_after"] < info["tokens_before"]
    assert not seen[0].startswith("[앞선 요약]") and "[사용자] 문체는 건조하게 해줘." in seen[0]
    assert "<previous_work_summary>" in note and "\n새 요약\n</previous_work_summary>" in note
    # 사용자가 한 말은 요약하지 않고 그대로 남긴다. 하고 있던 요청은 끝에 한 번 더 적는다
    assert "<user_message>\n등대지기 딸의 이야기를 쓰자. 시점은 서윤이야.\n</user_message>" in note
    assert "<user_message>\n문체는 건조하게 해줘.\n</user_message>" in note
    assert note.endswith("<request_in_progress>\n대화를 요약으로 바꿀 때 하고 있던 요청이다.\n다음 장면을 써줘\n</request_in_progress>")
    assert sanitize_history(out) == out

    # 두 번째 압축: 앞의 요약은 잘리지 않고 통째로 넘어가고, 그때 남긴 말도 이어진다
    second = [out[0], _say("다" * 6000), _ask("아침 장면에 미역국을 넣어줘."), _say("라" * 6000), _ask("이어서 써줘"), _say("썼다.")]

    async def again(prompt: str) -> str:
        seen.append(prompt)
        return "합친 요약"

    out2, info2 = await compaction.compact_messages(second, 4000, summarize=again, goal="이어서 써줘")
    note2 = out2[0].parts[0].content
    assert seen[1].startswith("[앞선 요약]\n새 요약\n\n[그 뒤의 기록]\n") and "<user_message>" not in seen[1]
    assert [w in note2 for w in ("시점은 서윤이야.", "문체는 건조하게 해줘.", "아침 장면에 미역국을 넣어줘.")] == [True, True, True]
    assert "\n합친 요약\n</previous_work_summary>" in note2 and note2.count("<previous_work_summary>") == 1

    # 요약에 실패해도 앞의 요약과 사용자의 말은 남는다
    async def broken(prompt: str) -> str:
        raise RuntimeError("보조 모델 없음")

    out3, info3 = await compaction.compact_messages(second, 4000, summarize=broken, goal="이어서 써줘")
    note3 = out3[0].parts[0].content
    assert info3["failed"] and "보조 모델 없음" in info3["error"]
    assert "새 요약" in note3 and "요약을 만들지 못했다" in note3 and "아침 장면에 미역국을 넣어줘." in note3

    # 손으로 돌릴 때(force)는 한도를 넘지 않았어도, 한도가 없어도 요약한다
    small = [_ask("첫 말"), _say("가" * 400), _ask("둘째 말"), _say("나" * 400), _ask("셋째 말"), _say("끝.")]
    assert (await compaction.compact_messages(small, 0, summarize=summarize))[1] is None
    out4, info4 = await compaction.compact_messages(small, 0, summarize=summarize, force=True)
    assert info4["kind"] == "summary" and len(out4) < len(small)


# ------------------------------------------------------------------ 횟수 한도는 없고, 헛돌 때만 멈춘다

async def test_no_cap_on_tool_calls_but_a_repeated_call_stops_the_run(ctx, models, work):
    def many(messages):
        done = sum(1 for m in messages if isinstance(m, ModelResponse))
        return {"tool": "search", "args": {"query": f"글귀 {done}"}} if done < 60 else "다 찾아봤다."

    models("test:agent", many)
    sid = work()
    events = await run(ctx, sid, "여기저기 찾아봐줘")
    assert (events[-1]["status"], events[-1]["total_tool_calls"]) == ("completed", 60)

    models("test:agent", lambda messages: {"tool": "list", "args": {}})
    events = await run(ctx, sid, "목록을 봐줘")
    assert (events[-1]["status"], events[-1]["total_tool_calls"]) == ("stalled", 10)
    error = next(e["error"] for e in events if e["type"] == "error")
    assert error.startswith("'목록 보기' 도구를 같은 내용으로 10번 연달아 불러서 멈췄습니다.")
    models("test:agent", ["알겠다."])                                       # 멈춘 뒤에도 대화는 이어진다
    assert (await run(ctx, sid, "그만하고 대답해줘"))[-1]["status"] == "completed"


# ------------------------------------------------------------------ 도구의 빈칸은 보조의 값

async def test_tools_follow_the_auxiliary_settings(ctx, models, work):
    calls: list[dict] = []
    original = ctx.llm.complete

    async def spy(model_ref, **kw):
        calls.append({"model": model_ref, **{k: kw.get(k) for k in ("temperature", "max_tokens", "thinking")}})
        return await original(model_ref, **kw)

    ctx.llm.complete = spy
    preset = test_preset(
        auxiliary_temperature=0.4, auxiliary_thinking="low", auxiliary_max_output_tokens=3000, auxiliary_max_input_tokens=40,
        temperature=1.2,
    )
    preset.tools[0] = preset.tools[0].model_copy(update={"model": ""})                          # 집필: 전부 보조를 따른다
    preset.tools[1] = preset.tools[1].model_copy(update={"temperature": 0.9, "thinking": "off", "max_tokens": 500})
    models("test:aux", ["보조 모델이 썼다."])
    models("test:agent", scripted([
        {"tool": "write", "args": {"path": "입력", "content": "짧은 지시서"}},
        {"tool": "compose", "args": {}},
        {"tool": "critique", "args": {}},
        {"tool": "write", "args": {"path": "입력", "content": "가" * 200}},
        {"tool": "compose", "args": {}},
        "끝.",
    ]))
    sid = work(preset=preset)
    out = results(await run(ctx, sid, "써줘"))
    assert calls == [
        {"model": "test:aux", "temperature": 0.4, "max_tokens": 3000, "thinking": "low"},      # 에이전트의 온도(1.2)를 따르지 않는다
        {"model": "test:critic", "temperature": 0.9, "max_tokens": 500, "thinking": "off"},
    ]
    assert out[1].endswith("보조 모델이 썼다.")
    # 최대 입력을 넘으면 자르지 않고 돌리지 않는다
    assert out[4] == (
        "오류: 입력이 약 100토큰(200자)이라 최대 입력 40토큰을 넘습니다. 도구를 돌리지 않았습니다. "
        "입력을 줄이거나(@include로 끌어오는 범위를 좁히거나) 나눠서 돌려야 합니다."
    )
    assert len(calls) == 2


def test_thinking_is_a_tool_setting():
    tool = parse_tool_markdown("---\nlabel: 퇴고\nthinking: high\nmax_tokens: 2000\n---\n\n다듬는다.\n")
    assert (tool.thinking, tool.max_tokens) == ("high", 2000) and "thinking: high" in dump_tool_markdown(tool)
    assert parse_tool_markdown("---\nlabel: 퇴고\nthinking: 아무거나\n---\n\n다듬는다.\n").thinking == ""   # 모르는 값은 "보조를 따름"
    assert "thinking" not in dump_tool_markdown(ToolDef(label="퇴고", prompt="다듬는다."))


# ------------------------------------------------------------------ 그 밖의 경계 사례

async def test_compaction_never_loses_a_request_and_keeps_odd_text_intact():
    async def summarize(prompt: str) -> str:
        return "요약"

    # 실행이 길어져 지금의 요청이 요약되는 구간에 들어가도, 그 요청은 다른 말과 같이 원문으로 남는다
    long_run = [
        _ask("3장은 일인칭으로 해줘"), _say("가" * 6000),
        _ask("해줘"), _call("read", "1"), _result("read", "1", "나" * 300), _say("다" * 6000),
        _call("read", "2"), _result("read", "2", "본문"), _say("하는 중."),
    ]
    out, _ = await compaction.compact_messages(long_run, 4000, summarize=summarize, goal="해줘")
    note = out[0].parts[0].content
    assert "<user_message>\n3장은 일인칭으로 해줘\n</user_message>" in note    # 요청과 끝이 같은 앞의 말이 빠지지 않는다
    assert "<user_message>\n해줘\n</user_message>" in note and "<request_in_progress>" in note

    # 다음 실행에서 또 줄여도 앞의 요청이 원문으로 남고, 그때의 요청이 "지금"이라고 적히지 않는다
    later = [out[0], _say("라" * 6000), _ask("이번에는 4장을 봐줘"), _say("마" * 6000), _ask("계속"), _say("끝.")]
    out2, _ = await compaction.compact_messages(later, 4000, summarize=summarize, goal="계속")
    note2 = out2[0].parts[0].content
    assert "<user_message>\n해줘\n</user_message>" in note2 and "<user_message>\n이번에는 4장을 봐줘\n</user_message>" in note2
    assert note2.count("<request_in_progress>") == 1 and note2.rstrip().endswith("계속\n</request_in_progress>")

    # 사용자의 말에 닫는 표가 들어 있어도 잘리지 않고 돌아온다
    odd = "이 표를 본문에 넣어줘:\n</user_message>\n그리고 이어서 써줘"
    first, _ = await compaction.compact_messages(
        [_ask(odd), _say("가" * 6000), _ask("둘째"), _say("나" * 6000), _ask("셋째"), _say("끝.")], 4000, summarize=summarize,
    )
    again, _ = await compaction.compact_messages(
        [first[0], _say("다" * 6000), _ask("넷째"), _say("라" * 6000), _ask("다섯째"), _say("끝.")], 4000, summarize=summarize,
    )
    assert again[0].parts[0].content.count("그리고 이어서 써줘") == 1 and "<user_message>\n둘째\n</user_message>" in again[0].parts[0].content


async def test_compaction_counts_files_sanely_and_follows_measured_tokens(ctx, models, work):
    from pydantic_ai.messages import BinaryContent
    from pydantic_ai.usage import RequestUsage

    # 대화에 든 이미지를 바이트 수로 세지 않는다 (200KB 이미지 하나로 한도를 넘은 것으로 보면 안 된다)
    image = ModelRequest(parts=[UserPromptPart(content=["[자료/삽화/등대.png]", BinaryContent(data=b"0" * 200_000, media_type="image/png")])])
    with_image = [_ask("삽화를 봐줘"), _call("view_file", "1"), _result("view_file", "1", "첨부했다"), image, _say("봤다."), _ask("고마워"), _say("끝.")]
    assert compaction.estimate_tokens(with_image)[0] < 5_000

    async def summarize(prompt: str) -> str:
        return "요약"

    out, _ = await compaction.compact_messages(
        [with_image[0], *with_image[1:5], _say("가" * 9000), _ask("둘째"), _say("나" * 9000), _ask("셋째"), _say("끝.")],
        6000, summarize=summarize,
    )
    assert "[자료/삽화/등대.png]" not in out[0].parts[0].content            # 도구가 붙여 준 파일은 사용자의 말이 아니다

    # 글자 하나가 토큰 하나를 넘는 모델: 남기는 구간을 실측에 맞춰 줄인다. 그러지 않으면 줄인 뒤에도 한도 근처라 요청마다 다시 줄인다
    def measured(text: str, tokens: int) -> ModelResponse:
        return ModelResponse(parts=[TextPart(content=text)], usage=RequestUsage(input_tokens=tokens, output_tokens=0))

    turns: list = []
    for n in range(12):
        turns += [_ask(f"{n}번째 요청"), _say("가" * 1000)]
    dense = [*turns, _ask("마지막"), measured("끝.", 20_000)]              # 12,000자 남짓이 20,000토큰 = 글자당 1.6토큰
    out, info = await compaction.compact_messages(dense, 10_000, summarize=summarize)
    kept_chars = compaction._chars(out[1:])
    assert info["kind"] == "summary" and kept_chars * 1.6 < 10_000 * 0.5    # 남긴 구간이 실제 토큰으로 한도의 절반 아래다
    assert info["tokens_after"] < 10_000 * 0.7

    # 줄였는데도 한도를 넘으면(지침과 노트가 한도를 거의 채울 때) 요청마다 다시 줄이지 않고 한 번 알린다
    big = "가 " * 1500
    models("test:agent", scripted([{"tool": "write", "args": {"path": f"자료/글 {n}", "content": big}} for n in range(8)] + ["끝."]))
    models("test:aux", ["요약."])
    sid = work(context_budget=1200)                                         # 지침만으로도 넘는 한도
    events = await run(ctx, sid, "글을 여러 편 써줘")
    summaries = [e for e in events if e["type"] == "compaction" and e["kind"] == "summary"]
    warned = [e for e in events if e["type"] == "notice" and "줄였는데도 컨텍스트 한도를 넘습니다" in e["text"]]
    assert events[-1]["status"] == "completed" and 1 <= len(summaries) <= 4 and len(warned) == 1


async def test_parallel_summary_calls_do_not_lose_each_other(ctx, models, work):
    """모델이 한 응답에 요약 붙이기를 여러 번 부르면 전부 붙는다 (원고의 색인을 동시에 읽고 쓰지 않는다)."""
    from pydantic_ai.models.function import FunctionModel

    from aleph.providers.factory import register_test_model

    count = 12

    import json

    from pydantic_ai.models.function import DeltaToolCall

    async def stream(messages, info):
        if isinstance(messages[-1].parts[0], UserPromptPart):             # 새 요청이 막 들어왔을 때: 한 응답에 전부 부른다
            for n in range(1, count + 1):
                args = json.dumps({"target": f"원고/s{n}", "summary": f"{n}번 장면의 요약"}, ensure_ascii=False)
                yield {n: DeltaToolCall(name="set_summary", json_args=args, tool_call_id=f"c{n}")}
        else:
            yield "다 붙였다."

    register_test_model("test:agent", FunctionModel(stream_function=stream))
    sid = work()
    m = ctx.docs(sid).manuscript
    for n in range(count):
        m.insert(f"{n}번째 글.", by="user")
    for _ in range(5):
        for n in range(1, count + 1):
            m.set_scene(f"s{n}", summary=None)
        events = await run(ctx, sid, "요약을 전부 붙여줘")
        assert events[-1]["status"] == "completed" and len(results(events)) == count
        assert all(r.endswith("요약을 붙였습니다.") for r in results(events))
        scenes = m.overview()["chapters"][0]["scenes"]
        assert [s["summary"] for s in scenes] == [f"{n}번 장면의 요약" for n in range(1, count + 1)]


async def test_cycles_and_oversized_batch_inputs_are_stopped(ctx, models, work):
    # 두 가지 호출만 번갈아 되풀이해도 멈춘다 (같은 호출이 연달아 온 것은 아니라서 앞의 장치로는 못 잡는다)
    def ping_pong(messages):
        done = sum(1 for m in messages if isinstance(m, ModelResponse))
        return {"tool": "list", "args": {"path": "자료" if done % 2 else "원고"}}

    models("test:agent", ping_pong)
    sid = work()
    events = await run(ctx, sid, "목록을 봐줘")
    assert (events[-1]["status"], events[-1]["total_tool_calls"]) == ("stalled", 30)
    assert "같은 도구 호출 몇 가지만 30번 넘게 되풀이해서 멈췄습니다" in next(e["error"] for e in events if e["type"] == "error")

    # 묶음 요약도 최대 입력을 지킨다
    preset = test_preset(id="limited", auxiliary_max_input_tokens=50)
    models("test:agent", scripted([{"tool": "summarize_scenes", "args": {}}, "끝."]))
    sid = work(preset=preset)
    m = ctx.docs(sid).manuscript
    m.insert("짧은 장면.", by="user")
    m.insert("긴 장면. " * 60, by="user")
    out = results(await run(ctx, sid, "요약해줘"))[0]
    assert out.startswith("'요약' 도구로 1곳에 요약을 붙였습니다. 실패한 곳 1곳 — 1장 2번째 장면: 입력이 약 180토큰") and m.stale() == ["s2"]


async def test_web_search_result_that_arrives_late_or_never_is_not_shown_as_null(ctx, work):
    """Gemini는 검색의 출처 목록을 응답의 맨 끝에야 채운다. 결과 조각이 처음 왔을 때는 비어 있다."""
    from pydantic_ai.messages import NativeToolCallPart, NativeToolReturnPart
    from pydantic_ai.models.function import FunctionModel

    from aleph.agent.native import NO_RESULT, native_result_text
    from aleph.providers.factory import register_test_model

    assert [native_result_text("web_search", c) for c in (None, "", [], {})] == ["", "", "", ""]   # "null"이 아니다
    late = NativeToolReturnPart(tool_name="web_search", content=None, tool_call_id="w1")

    async def stream(messages, info):
        yield {0: NativeToolCallPart(tool_name="web_search", args={"queries": ["등대 구조"]}, tool_call_id="w1")}
        yield {1: late}
        yield {2: NativeToolCallPart(tool_name="web_search", args={"queries": ["등대지기"]}, tool_call_id="w2")}
        yield {3: NativeToolReturnPart(tool_name="web_search", content=None, tool_call_id="w2")}
        yield "찾아"
        late.content = {"sources": [{"title": "등대의 역사", "uri": "https://example.org/a"}]}   # 응답의 끝에서 채워진다
        yield "봤다."

    register_test_model("test:agent", FunctionModel(stream_function=stream))
    sid = work("plan", preset=test_preset(id="searcher2", web_search=True))
    events = await run(ctx, sid, "찾아봐")
    found = {e["tool_call_id"]: e["result"] for e in events if e["type"] == "tool_result"}
    assert events[-1]["status"] == "completed" and "null" not in found.values() and len(found) == 2
    assert found["w2"] == NO_RESULT["web_search"]                           # 끝까지 안 온 것은 그렇다고 적는다
    assert found["w1"] == "등대의 역사 — https://example.org/a"              # 늦게 채워진 출처는 그때 보인다
