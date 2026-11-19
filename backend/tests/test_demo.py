"""시연 서버의 가짜 에이전트가 시연용 프리셋으로 끝까지 도는지.

키 없이 앱을 보여 줄 수 있는 유일한 길이라 깨지면 안 된다.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from aleph.tools.definitions import ToolDef
from tests.conftest import asks, collect, results, run, send

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
SAMPLE = (SCRIPTS / "시연용 글" / "등대지기의 딸.txt").read_text(encoding="utf-8").strip()


@pytest.fixture(scope="module")
def demo():
    spec = importlib.util.spec_from_file_location("demo_server", SCRIPTS / "demo_server.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["demo_server"] = module       # dataclass가 자기 모듈을 찾을 수 있어야 한다
    spec.loader.exec_module(module)
    module.PACE = 0
    module.register_models()
    return module


@pytest.fixture
def start(ctx, demo):
    def create(mode: str, name: str = "시연") -> str:
        demo.ensure_demo_preset(ctx)
        demo.use_demo_models(ctx)
        sid = ctx.create_session(name, "demo")["id"]
        ctx.set_state(sid, mode=mode)
        return sid

    return create


def clean(events: list[dict]) -> list[dict]:
    problems = [e.get("result") or e.get("error") for e in events if e["type"] == "error" or (e["type"] == "tool_result" and not e["ok"])]
    assert events[-1]["status"] == "completed" and not problems, problems
    return events


async def test_writing_together_in_auto_mode(ctx, demo, start):
    sid = start("auto")
    docs = ctx.docs(sid)
    events = clean(await run(ctx, sid, "등대지기 딸 이야기 첫 장면을 써 줘.", ["아버지", "승인", "승인"]))
    kinds = [(a["kind"], a.get("action")) for a in asks(events)]
    assert kinds == [("question", None), ("tool_confirm", None), ("proposal", "insert")]
    thinking = [e["text"] for e in events if e["type"] == "thinking"]
    assert len(thinking) == 1 and thinking[0].startswith("원고가 비어 있다.")       # 첫 단계에는 생각이 먼저 보인다
    assert "시점: 아버지" in asks(events)[1]["input"] and demo.CHARACTER in asks(events)[1]["input"]   # 확인 화면에 풀린 입력이 보인다
    scene = docs.manuscript.overview()["chapters"][0]["scenes"][0]
    assert docs.manuscript.content("s1") == demo.SCENE and scene["summary_state"] == "ok"
    assert scene["summary"] == "폭풍이 치는 밤, 서윤이 꺼진 등대의 불을 켜러 등탑에 오른다."
    assert "- [x] 첫 장면" in docs.get("자료/단기 계획.md") and docs.get("자료/인물/서윤.md") == demo.CHARACTER

    # 같은 작업에서 다시 요청하면 다음 장면. 입력은 앞 장면을 @include로 끌어온다
    events = clean(await run(ctx, sid, "다음 장면도 써 줘.", ["승인"]))
    assert docs.manuscript.content("s2") == demo.SCENE2 and "@include:원고/s1" in docs.text("입력")
    log = [c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "compose"][-1]
    assert demo.SCENE in log["input"] and "@include" not in log["input"]

    # 문서에서 인용해 요청하면 그 대목의 마지막 문장을 덜어내는 수정을 한다
    first = demo.SCENE.split("\n\n")[0]
    events = clean(await run(ctx, sid, f"[인용: 원고/s1]\n> {first}\n\n이 대목을 더 짧게.", ["승인"]))
    ask = asks(events)[0]
    assert (ask["action"], ask["path"]) == ("write", "원고/s1") and "삼십 년" in ask["old"] and "삼십 년" not in ask["new"]
    assert docs.manuscript.content("s1").startswith("바람이 계단을 타고 올라왔다. 서윤은 난간을 붙잡고 한 칸씩 발을 옮겼다.\n\n")

    # 고친 장면은 요약이 낡는다. 요약을 붙여 달라고 하면 낡은 것만 다시 붙인다
    state = lambda i: next(s for s in docs.manuscript.overview()["chapters"][0]["scenes"] if s["id"] == i)["summary_state"]  # noqa: E731
    assert (state("s1"), state("s2")) == ("stale", "ok")
    events = clean(await run(ctx, sid, "요약을 다시 붙여 줘."))
    assert results(events) == ["'요약' 도구로 1곳에 요약을 붙였습니다."] and state("s1") == "ok"
    # 장면에 '요약 실패'라고 적으면 그 요약이 일부러 실패한다 (실행은 끝까지 가고, 어디가 실패했는지 돌아온다)
    docs.apply(docs.plan_write("원고/s2", demo.SCENE2 + "\n\n요약 실패"), by="user")
    events = await run(ctx, sid, "요약을 다시 붙여 줘.")
    assert events[-1]["status"] == "completed" and "실패한 곳 1곳 — 1장 2번째 장면" in results(events)[0]
    assert next(e for e in reversed(events) if e["type"] == "text")["text"].startswith("요약을 붙이다가 실패한 장면이 있다.")
    docs.apply(docs.plan_write("원고/s2", demo.SCENE2), by="user")

    # 원고에 넣는 것을 반려하면 멈추고, 쓴 글은 출력에 남는다
    events = await run(ctx, sid, "한 장면 더.", ["문장이 너무 길다"])
    assert events[-1]["status"] == "completed" and docs.text("출력") == demo.CONTINUATION
    assert next(e for e in reversed(events) if e["type"] == "text")["text"].startswith("알겠다. 여기서 멈춘다.")
    assert len(docs.manuscript.scene_ids()) == 2


async def test_handing_off_in_autonomous_mode(ctx, demo, start):
    sid = start("autonomous")
    events = clean(await run(ctx, sid, "등대지기 딸 이야기를 두 장면으로 써 줘."))
    assert not asks(events)
    docs = ctx.docs(sid)
    m = docs.manuscript
    assert [m.content(i) for i in m.scene_ids()] == [demo.SCENE, demo.SCENE2]
    assert not docs.exists("자료/초고/아침.md")                              # 보관했던 초고는 원고로 옮겨졌다
    assert docs.text("출력") == demo.CRITIQUE                               # 출력에는 마지막으로 돈 도구의 결과가 남아 있다
    runs = [c for c in ctx.sessions.read_tool_call_log(sid) if not c["tool"].startswith("[")]
    assert [c["tool"] for c in runs] == ["compose", "compose", "critique", "summarize", "summarize"]   # 끝에 두 장면의 요약을 한꺼번에
    assert all(s["summary_state"] == "ok" for s in m.overview()["chapters"][0]["scenes"])
    assert demo.SCENE2 in runs[2]["input"] and runs[2]["output"] == demo.CRITIQUE   # 비평 도구에는 초고가 @include로 들어갔다
    assert demo.SCENE in runs[1]["input"]                                   # 둘째 장면의 입력에는 첫 장면이 들어갔다
    assert "스스로 정한 것" in docs.get("자료/단기 계획.md")


async def test_manual_and_plan_modes(ctx, demo, start):
    sid = start("plan")
    events = clean(await run(ctx, sid, "어떻게 쓸지 계획부터 세워 줘.", ["두 장면으로 끝"]))
    docs = ctx.docs(sid)
    assert docs.get("자료/단기 계획.md") == demo.PLAN and docs.noted("자료/단기 계획.md") and docs.manuscript.scene_ids() == []
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["list", "write", "set_note", "ask_user"]

    ctx.set_state(sid, mode="manual")                                      # 모드를 바꿔 실행한다
    events = clean(await run(ctx, sid, "계획대로 첫 장면을 써 줘.", ["서윤", "승인", "승인", "승인", "승인", "승인"]))
    kinds = [(a["kind"], a.get("action"), a.get("path")) for a in asks(events)]
    assert kinds == [
        ("question", None, None), ("proposal", "write", "자료/인물/서윤"), ("tool_confirm", None, None),
        ("proposal", "insert", "원고"), ("tool_confirm", None, None), ("proposal", "write", "자료/단기 계획"),   # 요약 도구도 돌리기 전에 묻는다
    ]
    assert docs.manuscript.content("s1") == demo.SCENE


async def test_uploaded_text_is_split_into_scenes(ctx, demo, start):
    sid = start("auto")
    docs = ctx.docs(sid)
    docs.apply(docs.plan_write("자료/올린 글/등대지기의 딸", SAMPLE), by="user", origin={"uploaded": "등대지기의 딸.txt"})
    events = clean(await run(ctx, sid, "올린 글을 장면으로 나눠서 원고에 넣어 줘.", ["승인"]))
    ask = asks(events)[0]
    assert ask["action"] == "split" and len(ask["pieces"]) == 2
    m = docs.manuscript
    ids = m.scene_ids()
    assert len(ids) == 2 and "\n\n".join(m.content(i) for i in ids) == SAMPLE      # 글은 한 글자도 바뀌지 않았다
    assert all(s["summary_state"] == "ok" for s in m.overview()["chapters"][0]["scenes"])
    assert docs.get("자료/올린 글/등대지기의 딸.md") == SAMPLE

    # 이어 쓰면 올린 글의 뒤를 잇는다
    clean(await run(ctx, sid, "여기서 이어서 써 줘.", ["승인"]))
    assert m.content(m.scene_ids()[-1]) == demo.CONTINUATION


async def test_other_abilities_have_scripts(ctx, demo, start):
    """웹 검색, 찾아 바꾸기, 파일 보기, 실행 중에 받은 말, 요청 되돌리기."""
    from aleph.workspace import undo

    sid = start("autonomous")
    docs = ctx.docs(sid)
    clean(await run(ctx, sid, "등대지기 딸 이야기를 두 장면으로 써 줘."))

    # 찾아 바꾸기: 따옴표로 두 글귀를 주면 된다. 그 요청은 통째로 되돌릴 수 있다
    events = clean(await run(ctx, sid, "'서윤'을 '서연'으로 바꿔 줘."))
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["search", "replace_all"]
    assert "서윤" not in docs.manuscript.text() and "서연은 난간을" in docs.manuscript.text()
    undo.revert(ctx.sessions, sid, events[0]["run_id"])
    assert "서연" not in docs.manuscript.text() and docs.manuscript.content("s1") == demo.SCENE

    # 웹 검색: 프리셋에서 켜 두었을 때만. 제공자가 실행하는 도구로 보인다
    events = clean(await run(ctx, sid, "그 시대 등대가 어떻게 생겼는지 찾아봐 줘."))
    assert not any(e.get("native") for e in events)                         # 꺼져 있으면 검색하지 않고 다음 장면을 쓴다
    preset = ctx.presets.get("demo")
    preset.web_search = True
    ctx.presets.save(preset)
    events = clean(await run(ctx, sid, "그 시대 등대가 어떻게 생겼는지 찾아봐 줘."))
    native = [(e["type"], e["tool"], e["label"]) for e in events if e.get("native")]
    assert native == [("tool_call", "web_search", "웹 검색"), ("tool_result", "web_search", "웹 검색")]
    assert "example.org/lighthouse-history" in next(e["result"] for e in events if e["type"] == "tool_result" and e.get("native"))
    assert "출처: https://example.org" in docs.get("자료/조사/등대.md")

    # 원고를 훑어 달라고 하면 직접 읽지 않고 읽기 에이전트에게 맡긴다
    events = clean(await run(ctx, sid, "서윤이 어떻게 그려지는지 원고를 훑어봐 줘."))
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["explore"]
    stream = "".join(e["delta"] for e in events if e["type"] == "tool_stream")
    assert stream.startswith("목록 보기: 원고\n찾기: 서윤\n") and "서윤은 말보다 손과 발로 그려진다." in results(events)[0]

    # 그림을 만들어 달라고 하면 이미지 모델이 만든다 (에이전트 모델과 따로다). 이미지 모델은 골라 둬야 한다
    assert ctx.presets.get("demo").image_model == ""
    ctx.presets.save(ctx.presets.get("demo").model_copy(update={"image_model": "demo:image"}))
    events = clean(await run(ctx, sid, "첫 장면의 삽화를 그려 줘."))
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["generate_image"]
    made = docs.get_bytes("자료/삽화/등탑의 밤.png")
    assert made[:8] == b"\x89PNG\r\n\x1a\n" and len(made) > 200

    # 파일 보기
    docs.save_file("자료/삽화/등대.png", b"\x89PNG\r\n\x1a\n0000", by="user")
    events = clean(await run(ctx, sid, "올려 둔 삽화를 봐 줘."))
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["view_file"]

    # 실행 중에 말을 걸면: 하던 대본을 끝까지 하고, 받았다고 답한다
    send(ctx, sid, "다음 장면도 써 줘.")
    events = []
    async for e in ctx.runs.stream(sid):
        events.append(e)
        if e["type"] == "tool_call" and e["tool"] == "compose":
            assert ctx.runs.steer(sid, "이번에는 더 짧게")
    assert events[-1]["status"] == "completed" and [e["tool"] for e in events if e["type"] == "tool_call"] == ["write", "compose", "insert_scene", "summarize_scenes"]
    assert "실행 중에 보낸 말('이번에는 더 짧게')은 받았다" in [e["text"] for e in events if e["type"] == "text"][-1]

    # 한 실행에서 두 번 말을 걸면 둘 다 받았다고 한다
    send(ctx, sid, "한 장면 더 써 줘.")
    events = []
    async for e in ctx.runs.stream(sid):
        events.append(e)
        if e["type"] == "tool_call" and e["tool"] == "write":
            assert ctx.runs.steer(sid, "첫째 말") and ctx.runs.steer(sid, "둘째 말")
    assert "실행 중에 보낸 말('첫째 말', '둘째 말')은 받았다" in [e["text"] for e in events if e["type"] == "text"][-1]


async def test_tools_run_directly_and_by_name(ctx, demo, start):
    sid = start("auto")
    docs = ctx.docs(sid)
    preset = ctx.presets.get("demo")
    preset.tools.append(ToolDef(label="줄거리 짜기", description="입력의 설정으로 줄거리를 짠다.", prompt="당신은 구성 작가다."))
    ctx.presets.save(preset)

    # 도구를 지정해 요청하면, 에이전트가 요청을 입력에 덧붙이고 그 도구를 돌린다
    docs.apply(docs.plan_write("입력", "# 설정\n\n- 섬, 등대, 아버지와 딸"), by="user")
    events = clean(await run(ctx, sid, "결말은 열어 둔다", tool="줄거리 짜기"))
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["read", "write", "tool_1"]
    assert docs.text("입력") == "# 설정\n\n- 섬, 등대, 아버지와 딸\n\n- 이번에 특히: 결말은 열어 둔다\n"
    assert docs.text("출력").startswith("(시연용 가짜 모델의 대답)") and "받은 입력의 첫 줄: # 설정" in docs.text("출력")

    # 도구만 보내면 에이전트를 거치지 않고 바로 돈다
    docs.apply(docs.plan_write("입력", demo.BRIEF.format(pov="서윤")), by="user")
    send(ctx, sid, "/집필", tool="compose", kind="tool")
    events = await collect(ctx, sid)
    assert events[-1]["status"] == "completed" and docs.text("출력") == demo.SCENE
    assert "".join(e["delta"] for e in events if e["type"] == "tool_stream") == demo.SCENE     # 쓰는 과정이 흘러나온다
    assert results(events)[0].startswith("'집필' 도구의 결과가 출력에 들어갔습니다")


def test_demo_server_brings_one_recorded_work(ctx, demo):
    """그냥 켠 시연 서버는 같이 들어 있는 작업 하나를 넣어 띄운다. 두 번 넣지 않고, 지웠으면 다시 넣는다."""
    sid = demo.ensure_demo_work(ctx)
    assert demo.ensure_demo_work(ctx) == sid and [s["id"] for s in ctx.sessions.list_sessions()] == [sid]
    docs = ctx.docs(sid)
    assert docs.manuscript.scene_ids() and docs.paths("자료") and len(ctx.presets.list()) == 1
    assert any(e["type"] == "tool_call" for e in ctx.sessions.read_events(sid))
    assert ctx.state(sid).preset_id == ctx.presets.list()[0]["id"]
    ctx.sessions.delete_session(sid)
    assert demo.ensure_demo_work(ctx) != sid and len(ctx.sessions.list_sessions()) == 1
