"""에이전트 실행 — 가짜 모델로 끝까지 돌려 본다. 모드마다의 확인, 수정 방지, 도구, 긴 글 나누기."""

from __future__ import annotations

from pydantic_ai.messages import ModelRequest, UserPromptPart

from aleph.tools.agent_tools import build_agent_tools
from aleph.workspace.documents import INPUT, OUTPUT
from tests.conftest import asks, collect, results, run, scripted, send, test_preset


def call(tool: str, **args) -> dict:
    return {"tool": tool, "args": args}


# ------------------------------------------------------------------ 자율

async def test_autonomous_run_writes_a_scene(ctx, models, work):
    seen: list[str] = []
    models("test:agent", [
        call("write", path="자료/인물/서윤", content="등대지기의 딸"),
        call("write", path="입력", content="서윤이 등대에 오른다.\n\n인물: @include:자료/인물/서윤"),
        call("compose"),
        call("insert_scene", from_output=True),
        call("set_summary", target="원고/s1", summary="서윤이 등탑에 오른다."),
        "원고에 올렸다.",
    ], seen)
    sid = work("autonomous")
    events = await run(ctx, sid, "첫 장면을 써줘")
    assert events[-1]["status"] == "completed" and not asks(events)      # 자율은 원고도 묻지 않고 쓴다

    docs = ctx.docs(sid)
    scene = docs.manuscript.overview()["chapters"][0]["scenes"][0]
    assert docs.get("원고/s1.md") == "바람이 불었다." and docs.text(OUTPUT) == ""
    assert (scene["summary"], scene["summary_state"], scene["by"]) == ("서윤이 등탑에 오른다.", "ok", "agent")
    assert docs.history("원고/s1")[0]["origin"]["from_output"] is True

    out = results(events)
    assert out[2] == "'집필' 도구의 결과가 출력에 들어갔습니다 (8자).\n\n바람이 불었다."
    assert out[3] == "원고에 장면을 넣었습니다: 1장 1번째 장면 — 경로 '원고/s1' (8자). 요약은 아직 없습니다. 출력은 비웠습니다."
    assert out[4] == "1장 1번째 장면에 요약을 붙였습니다."                 # 요약은 에이전트가 붙인다
    calls = [e for e in events if e["type"] == "tool_call"]
    assert (calls[2]["label"], calls[2]["user_tool"]) == ("집필", True) and calls[3]["label"] == "원고에 넣기"
    changed = [e["changed"] for e in events if e["type"] == "tool_result"]
    # 바뀐 장면의 경로도 같이 온다. 요약을 붙여도 그 장면이 바뀐 것으로 알린다 (화면이 목록을 다시 그리게)
    assert changed == [["자료/인물/서윤"], ["입력"], ["출력"], ["출력", "원고", "원고/s1"], ["원고", "원고/s1"]]

    # 도구에는 입력만, @include가 풀려서 들어간다. 기록에는 풀기 전과 후가 다 남는다
    log = next(c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "compose")
    assert log["input"] == "서윤이 등대에 오른다.\n\n인물: 등대지기의 딸" and "@include:자료/인물/서윤" in log["input_raw"]
    assert (log["label"], log["by"], log["output"]) == ("집필", "agent", "바람이 불었다.")

    # 에이전트는 작업 공간의 쓰는 법, 모드, 요청을 시작할 때의 상태, 프리셋의 지침을 받는다
    first = seen[0]
    assert first.startswith("<workspace>") and "지금은 자율 모드입니다" in first and first.rstrip().endswith("당신은 창작 에이전트다.")
    assert "<work>\n입력: 비어 있음\n출력: 비어 있음\n</work>" in first and "(원고 비어 있음)" in first
    assert events[-1]["usage"]["context_tokens"] > 0 and ctx.sessions.conversation(sid, "main")["context_tokens"] > 0


async def test_tool_errors_come_back_as_results(ctx, models, work):
    def broken(messages):
        raise RuntimeError("모델이 응답하지 않음")

    models("test:agent", [
        call("compose"),                                                  # 입력이 비어 있다
        call("write", path="입력", content="지시서"),
        call("compose"),                                                  # 도구의 모델이 죽는다
        call("write", path="딴 곳/메모", content="x"),                    # 자리 밖
        call("read", path="자료/없는 문서"),
        "끝.",
    ])
    models("test:writer", broken)
    sid = work("autonomous")
    events = await run(ctx, sid, "써줘")
    out = results(events)
    assert events[-1]["status"] == "completed"                           # 도구가 실패해도 실행은 죽지 않는다
    assert out[0].startswith("오류: 입력이 비어 있습니다")
    assert out[2] == "오류: '집필' 도구를 돌리지 못했습니다. 모델을 부르다가 문제가 생겼습니다. (RuntimeError: 모델이 응답하지 않음)"
    assert out[3].startswith("오류: '딴 곳/메모'에는 문서를 둘 수 없습니다") and "문서가 없습니다" in out[4]
    assert [e["ok"] for e in events if e["type"] == "tool_result"] == [False, True, False, False, True]
    assert ctx.sessions.read_tool_call_log(sid)[0]["error"].startswith("RuntimeError")


# ------------------------------------------------------------------ 자동

async def test_auto_mode_asks_for_the_manuscript_and_what_the_agent_flags(ctx, models, work):
    models("test:agent", scripted([
        call("write", path="자료/계획", content="첫 장면부터"),                       # 사소한 것 → 그냥
        call("write", path="자료/인물/서윤", content="등대지기의 딸", confirm=True),  # 에이전트가 확인을 청함
        call("write", path="입력", content="@include:자료/인물/서윤 이 등대에 오른다."),
        call("compose", confirm=True),                                               # 도구 실행 확인 → 사유를 적어 반려
        call("compose"),
        call("insert_scene", from_output=True),                                      # 원고는 항상 확인 → 반려
        call("insert_scene", from_output=True),                        # 다시 → 승인
        call("edit", path="원고/s1", old_text="바람", new_text="찬 바람"),            # 원고 고치기 → 승인
        call("ask_user", question="누구의 시점으로 쓸까요?", options=["서윤", "아버지", "직접 입력"]),
        call("delete", path="원고/s1"),                                              # 원고에서 지우기 → 승인
        "끝.",
    ]))
    sid = work("auto")
    events = await run(ctx, sid, "첫 장면", ["승인", "문체를 더 건조하게", "반려", "승인", "승인", "아버지", "승인"])
    assert events[-1]["status"] == "completed"

    kinds = [(a["kind"], a.get("action")) for a in asks(events)]
    assert kinds == [
        ("proposal", "write"), ("tool_confirm", None), ("proposal", "insert"), ("proposal", "insert"),
        ("proposal", "write"), ("question", None), ("proposal", "delete"),
    ]
    a = asks(events)
    assert (a[0]["path"], a[0]["old"], a[0]["new"], a[0]["options"]) == ("자료/인물/서윤", None, "등대지기의 딸", ["승인", "반려"])
    assert (a[1]["tool"], a[1]["label"], a[1]["input"]) == ("compose", "집필", "등대지기의 딸 이 등대에 오른다.")   # 풀린 입력이 보인다
    assert a[2]["new"] == "바람이 불었다." and a[2]["description"] == "원고에 장면 넣기: 원고의 끝" and a[2]["position"]["end"]
    assert (a[4]["path"], a[4]["old"], a[4]["new"]) == ("원고/s1", "바람이 불었다.", "찬 바람이 불었다.")
    assert a[4]["description"] == "원고 고치기: 1장 1번째 장면"
    assert a[5]["options"] == ["서윤", "아버지"]                           # '직접 입력'류 선택지는 뺀다 (입력창이 항상 있다)
    assert (a[6]["old"], a[6]["description"]) == ("찬 바람이 불었다.", "원고에서 지우기: 1장 1번째 장면")

    out = results(events)
    assert out[0] == "'자료/계획' 문서를 새로 썼습니다 (6자)."
    assert out[1].endswith("사용자가 승인했습니다.")
    assert out[3].startswith("사용자가 '집필' 도구의 실행을 반려했습니다 — 문체를 더 건조하게")
    assert out[5].startswith("사용자가 이 변경을 반려했습니다.") and "아무것도 바뀌지 않았습니다" in out[5]
    assert out[6].endswith("출력은 비웠습니다. 사용자가 승인했습니다.")
    assert out[7] == "1장 1번째 장면을 고쳤습니다 (10자). 사용자가 승인했습니다." and out[8] == "아버지"
    docs = ctx.docs(sid)
    assert docs.manuscript.scene_ids() == [] and [p["status"] for p in docs.proposals()] == [
        "accepted", "rejected", "accepted", "accepted", "accepted",
    ]
    assert len([c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "compose"]) == 1   # 반려된 실행은 돌지 않았다
    # 반려된 호출은 결과에 표시가 붙는다 (도구 실행 확인의 반려, 문서 변경 확인의 반려)
    assert [bool(e.get("rejected")) for e in events if e["type"] == "tool_result"] == [
        False, False, False, True, False, True, False, False, False, False,
    ]


# ------------------------------------------------------------------ 수동, 계획

async def test_manual_mode_confirms_every_change(ctx, models, work):
    models("test:agent", [
        call("write", path="입력", content="서윤이 등대에 오른다."),       # 입력은 확인 없이 (도구 확인 때 통째로 보인다)
        call("read", path="입력"),                                        # 읽기는 그냥
        call("write", path="자료/메모", content="메모"),                  # 확인
        call("compose"),                                                  # 확인
        call("move", source="출력", destination="자료/초고/첫 장면"),      # 확인
        "끝.",
    ])
    sid = work("manual")
    events = await run(ctx, sid, "첫 장면", ["승인", "승인", "입력에 넣을 게 아니다"])
    a = asks(events)
    assert [(x["kind"], x.get("action")) for x in a] == [("proposal", "write"), ("tool_confirm", None), ("proposal", "move")]
    assert (a[2]["path"], a[2]["dest"], a[2]["description"]) == ("출력", "자료/초고/첫 장면", "'출력' → '자료/초고/첫 장면' 옮기기")
    out = results(events)
    assert out[1] == "서윤이 등대에 오른다." and "반려했습니다 — 입력에 넣을 게 아니다" in out[4]
    assert ctx.docs(sid).text(OUTPUT) == "바람이 불었다."                 # 반려했으니 출력은 그대로


async def test_plan_mode_only_touches_materials(ctx, models, work):
    seen: list[str] = []
    models("test:agent", [
        call("list"),
        call("write", path="자료/계획", content="1. 인물 정하기\n2. 첫 장면"),
        call("set_note", path="자료/계획"),
        call("write", path="입력", content="지시서"),                      # 막힘
        call("ask_user", question="몇 장으로 쓸까요?"),
        "계획을 자료/계획에 적었다.",
    ], seen)
    sid = work("plan")
    ctx.docs(sid).manuscript.insert("이미 쓴 장면.", by="user")
    events = await run(ctx, sid, "계획을 세워줘", ["세 장"])
    out = results(events)
    assert "[원고]\n1장 1장면 8자" in out[0] and out[1].startswith("'자료/계획' 문서를 새로 썼습니다")
    assert out[2] == "'자료/계획'의 노트를 켰습니다. 다음 요청부터 자동으로 읽힙니다."
    assert out[3].startswith("오류: 계획 모드에서는 자료만 고칠 수 있습니다") and out[4] == "세 장"
    assert "지금은 계획 모드입니다" in seen[0] and ctx.docs(sid).noted("자료/계획.md") and not asks(events)[1:]

    # 계획 모드에는 원고 도구와 사용자 도구가 아예 없고, 자율 모드에는 묻기 도구가 없다
    assert {t.name for t in build_agent_tools("plan")} == {
        "list", "read", "search", "explore", "view_file", "write", "edit", "delete", "move", "replace_all", "set_note", "ask_user",
    }
    assert "ask_user" not in {t.name for t in build_agent_tools("autonomous")}
    assert {"insert_scene", "move_scene", "split", "merge_scenes", "set_summary", "summarize_scenes"} <= {t.name for t in build_agent_tools("auto")}
    assert "set_title" not in {t.name for t in build_agent_tools("auto")}       # 장과 장면에 제목은 없다


# ------------------------------------------------------------------ 수정 방지와 권한 무시

async def test_locked_documents_and_bypass(ctx, models, work):
    script = [
        call("edit", path="자료/인물/서윤", old_text="딸", new_text="손녀"),
        call("edit", path="원고/s1", old_text="바람", new_text="찬 바람"),
        call("insert_scene", content="새 장면.", after="s1"),
        call("write", path="자료/메모", content="열려 있는 문서"),
        "끝.",
    ]
    models("test:agent", scripted(script * 2))
    sid = work("autonomous")
    docs = ctx.docs(sid)
    docs.apply(docs.plan_write("자료/인물/서윤", "등대지기의 딸"), by="user")
    docs.manuscript.insert("바람이 불었다.", by="user")
    docs.set_flag("자료/인물", "locked", True)
    docs.set_flag("원고", "locked", True)

    out = results(await run(ctx, sid, "고쳐줘"))                          # 자율이어도 수정 방지는 못 넘는다
    assert out[0] == "오류: '자료/인물/서윤'에는 수정 방지가 걸려 있습니다. 에이전트는 고칠 수 없습니다."
    # 원고는 경로(원고/s1)가 아니라 자리로 부른다
    assert out[1].startswith("오류: 1장 1번째 장면에는 수정 방지") and out[2].startswith("오류: 1장에는 수정 방지")
    assert out[3].startswith("'자료/메모' 문서를 새로 썼습니다") and docs.get("자료/인물/서윤.md") == "등대지기의 딸"

    seen: list[str] = []
    models("test:agent", scripted(script), seen)
    ctx.set_state(sid, bypass_locks=True)                                # 권한 무시를 켜면 고칠 수 있다
    events = await run(ctx, sid, "이번엔 고쳐줘")
    out = results(events)
    assert all(not r.startswith("오류") for r in out), out
    assert docs.get("자료/인물/서윤.md") == "등대지기의 손녀" and docs.manuscript.text() == "찬 바람이 불었다.\n\n새 장면."
    assert "<bypass>" in seen[0] and events[0]["bypass_locks"] is True


async def test_replace_all_changes_many_documents_at_once(ctx, models, work):
    models("test:agent", scripted([
        call("replace_all", query="없는 이름", replacement="x"),
        call("replace_all", query="서윤", replacement="서연"),                 # 원고가 들어 있어 확인 → 반려
        call("replace_all", query="서윤", replacement="서연"),                 # 다시 → 승인
        call("replace_all", query="서연", replacement="서윤", path="자료"),     # 자료만 → 묻지 않는다
        "바꿨다.",
    ]))
    models("test:aux", ["요약."])
    sid = work("auto")
    docs = ctx.docs(sid)
    docs.apply(docs.plan_write("자료/인물/서윤", "서윤은 등대지기의 딸이다. 서윤은 말수가 적다."), by="user")
    docs.apply(docs.plan_write("자료/잠긴 문서", "서윤의 비밀"), by="user")
    docs.set_flag("자료/잠긴 문서", "locked", True)
    docs.manuscript.insert("서윤은 난간을 붙잡았다.", by="user")
    docs.manuscript.insert("아버지는 돌아보지 않았다.", by="user")

    events = await run(ctx, sid, "서윤을 서연으로 바꿔줘", ["이름은 그대로 둔다", "승인"])
    out = results(events)
    assert out[0] == "'없는 이름'이 나오는 곳이 없습니다."
    assert out[1].startswith("사용자가 이 변경을 반려했습니다 — 이름은 그대로 둔다")
    assert out[2] == (
        "문서 2개에서 3곳을 바꿨습니다: 1장 1번째 장면 1곳, 인물/서윤 2곳. "
        "수정 방지가 걸려 건너뛴 것: 잠긴 문서. 사용자가 승인했습니다."
    )
    ask = asks(events)[0]
    assert (ask["action"], ask["query"], ask["replacement"]) == ("replace", "서윤", "서연")
    assert ask["description"] == "찾아 바꾸기: '서윤' → '서연' (문서 2개, 3곳)"
    assert ask["items"][0] == {
        "path": "원고/s1", "title": "1장 1번째 장면", "count": 1,
        "samples": [{"before": "서윤은 난간을 붙잡았다.", "after": "서연은 난간을 붙잡았다."}],
    }
    assert len(asks(events)) == 2                                         # 자료만 바꿀 때는 묻지 않았다
    assert docs.manuscript.content("s1") == "서연은 난간을 붙잡았다." and docs.get("자료/잠긴 문서.md") == "서윤의 비밀"
    assert docs.get("자료/인물/서윤.md") == "서윤은 등대지기의 딸이다. 서윤은 말수가 적다."   # 넷째 호출이 자료만 되돌렸다
    changed = [e["changed"] for e in events if e["type"] == "tool_result"]
    assert changed[2] == ["자료/인물/서윤", "원고", "원고/s1"] and changed[3] == ["자료/인물/서윤"]


# ------------------------------------------------------------------ 긴 글 나누기

async def test_agent_splits_a_long_text_without_retyping_it(ctx, models, work):
    text = "배는 하루에 한 번 들어왔다.\n\n서윤은 선착장에서 기다렸다.\n\n\n그날 밤 폭풍이 왔다.\n\n아버지는 돌아오지 않았다.\n\n아침이 되자 바다는 잔잔했다."
    models("test:agent", scripted([
        call("read", path="자료/올린 글/등대지기의 딸"),
        call("split", path="자료/올린 글/등대지기의 딸", cuts=[{"before": "없는 문장"}]),
        call("split", path="자료/올린 글/등대지기의 딸", cuts=[
            {"before": "그날 밤 폭풍이"},
            {"before": "아침이 되자", "new_chapter": True},
        ]),
        call("merge_scenes", scenes=["원고/s1", "원고/s2"]),
        call("split", path="원고/s1", cuts=[{"before": "그날 밤 폭풍이"}]),
        call("move_scene", scene="원고/s3", at_start=True, chapter=1),
        call("summarize_scenes"),
        "나눴다.",
    ]))
    models("test:aux", ["요약."])
    sid = work("auto")
    docs = ctx.docs(sid)
    docs.apply(docs.plan_write("자료/올린 글/등대지기의 딸", text), by="user", origin={"uploaded": "등대지기의 딸.txt"})

    events = await run(ctx, sid, "올린 글을 장면으로 나눠줘", ["승인", "승인", "승인", "승인"])
    out = results(events)
    assert out[1].startswith("오류: 1번째 자를 자리를 원문에서 찾을 수 없습니다")
    assert out[2] == "장면 3개로 나눴습니다: 원고/s1, 원고/s2, 원고/s3. 요약은 아직 없습니다. 사용자가 승인했습니다."

    a = asks(events)
    assert a[0]["action"] == "split" and a[0]["description"] == "'자료/올린 글/등대지기의 딸'을 장면 3개로 나눠 원고에 넣기"
    assert [(p["new_chapter"], p["head"]) for p in a[0]["pieces"]] == [
        (False, "배는 하루에 한 번 들어왔다."), (False, "그날 밤 폭풍이 왔다."), (True, "아침이 되자 바다는 잔잔했다."),
    ]
    assert (a[1]["action"], a[1]["scenes"]) == ("merge", ["원고/s1", "원고/s2"]) and a[2]["action"] == "split"
    assert (a[3]["action"], a[3]["description"]) == ("reorder", "장면 옮기기: 2장 1번째 장면 → 1장의 맨 앞")

    m = docs.manuscript
    chapters = m.overview()["chapters"]
    assert len(chapters) == 1 and m.scene_ids() == ["s3", "s1", "s4"]
    # 나누고 합치고 다시 나눠도 글은 그대로다 (조각 사이의 빈 줄만 정리된다)
    assert m.content("s1") == "배는 하루에 한 번 들어왔다.\n\n서윤은 선착장에서 기다렸다."
    assert m.content("s4") == "그날 밤 폭풍이 왔다.\n\n아버지는 돌아오지 않았다." and m.content("s3") == "아침이 되자 바다는 잔잔했다."
    assert docs.get("자료/올린 글/등대지기의 딸.md") == text                # 자료의 원문은 그대로 남는다
    # 묶음 요약 한 번으로 장면마다 요약이 붙는다. 입력과 출력은 건드리지 않는다.
    assert out[6] == "'요약' 도구로 3곳에 요약을 붙였습니다."
    assert all((s["summary"], s["summary_state"]) == ("요약.", "ok") for c in chapters for s in c["scenes"])
    assert docs.text(INPUT) == "" and docs.text(OUTPUT) == ""
    logged = [e for e in ctx.sessions.read_tool_call_log(sid) if e["tool"] == "summarize"]
    assert sorted(e["target"] for e in logged) == ["원고/s1", "원고/s3", "원고/s4"] and {e["model"] for e in logged} == {"test:aux"}


# ------------------------------------------------------------------ 직접 돌리기, 도구 지정

async def test_user_runs_a_tool_directly_and_points_the_agent_at_one(ctx, models, work):
    sid = work("auto")
    docs = ctx.docs(sid)
    send(ctx, sid, "/집필", tool="compose", kind="tool")
    events = await collect(ctx, sid)
    assert events[-1]["status"] == "error" and results(events)[0].startswith("오류: 입력이 비어 있습니다")

    docs.apply(docs.plan_write("입력", "서윤이 등대에 오른다."), by="user")
    send(ctx, sid, "/집필", tool="compose", kind="tool")                   # 에이전트를 거치지 않는다
    events = await collect(ctx, sid)
    types = [e["type"] for e in events if e["type"] != "tool_stream"]
    assert types == ["run_started", "user_message", "tool_call", "tool_result", "done"]
    assert events[0]["kind"] == "tool" and (events[1]["text"], events[1]["tool"]) == ("/집필", "compose")
    assert events[-1]["status"] == "completed" and docs.text(OUTPUT) == "바람이 불었다." and docs.text(INPUT) == "서윤이 등대에 오른다."
    log = ctx.sessions.read_tool_call_log(sid)[-1]
    assert (log["by"], log["label"]) == ("user", "집필")

    # 다음 요청 때 에이전트는 사용자가 직접 한 일을 알고, 지정한 도구를 전달받는다
    seen: list[str] = []
    prompts: list[str] = []

    def script(messages):
        last = next(m for m in reversed(messages) if isinstance(m, ModelRequest))
        prompts.extend(p.content for p in last.parts if isinstance(p, UserPromptPart))
        return "알겠다."

    models("test:agent", script, seen)
    events = await run(ctx, sid, "문체에 주의해서 다시", tool="비평")       # 보이는 이름으로 적어도 된다
    assert "- 출력 (사용자가 '집필' 도구를 직접 돌려 나온 결과)" in seen[0] and "- 입력 (고침)" in seen[0]
    assert prompts[0].startswith("[사용자가 '비평' 도구(critique)를 쓰라고 지정했습니다.") and prompts[0].endswith("문체에 주의해서 다시")
    assert (events[1]["text"], events[1]["tool"], events[1]["tool_label"]) == ("문체에 주의해서 다시", "critique", "비평")


# ------------------------------------------------------------------ 파일 보기

async def test_agent_looks_at_images_and_scanned_pdfs(ctx, models, work):
    from pydantic_ai.messages import BinaryContent

    from aleph.agent.history import load_history

    shown: list[list] = []

    def script(messages):
        # 모델이 받은 것 가운데 파일(이미지, PDF)만 모아 둔다
        files = [
            (c.media_type, c.data)
            for m in messages if isinstance(m, ModelRequest)
            for p in m.parts if isinstance(p, UserPromptPart) and not isinstance(p.content, str)
            for c in p.content if isinstance(c, BinaryContent)
        ]
        shown.append(files)
        steps = [
            call("view_file", path="자료/삽화/등대.png"),
            call("view_file", path="자료/올린 글/스캔.pdf"),
            call("view_file", path="자료/계획"),
            call("view_file", path="자료/삽화/없음.png"),
            call("view_file", path="원고/s1"),
            "봤다.",
        ]
        return steps[min(len(shown) - 1, len(steps) - 1)]

    models("test:agent", script)
    sid = work("plan")                                                     # 보기만 하므로 계획 모드에서도 된다
    docs = ctx.docs(sid)
    png, pdf = b"\x89PNG\r\n\x1a\n" + b"0" * 16, b"%PDF-1.4 scanned"
    docs.save_file("자료/삽화/등대.png", png, by="user")
    docs.save_file("자료/올린 글/스캔.pdf", pdf, by="user")
    docs.apply(docs.plan_write("자료/계획", "계획"), by="user")
    assert docs.paths("자료") == ["자료/계획.md", "자료/삽화/등대.png", "자료/올린 글/스캔.pdf"]   # pdf에 .md가 붙지 않는다
    assert "자료/올린 글/스캔.pdf (파일)" in docs.material_listing()

    events = await run(ctx, sid, "삽화와 스캔본을 봐줘")
    out = results(events)
    assert out[0] == "'자료/삽화/등대.png' 파일을 아래에 첨부했습니다." and out[1] == "'자료/올린 글/스캔.pdf' 파일을 아래에 첨부했습니다."
    assert out[2] == "오류: 글 문서입니다. 글 문서는 read로 읽습니다." and out[3].startswith("오류: '자료/삽화/없음.png' 파일이 없습니다")
    assert out[4].startswith("오류:")
    assert shown[1] == [("image/png", png)]                                # 다음 모델 호출에 이미지가 그대로 들어간다
    assert shown[2] == [("image/png", png), ("application/pdf", pdf)]
    assert next(e for e in events if e["type"] == "tool_call")["label"] == "파일 보기"

    # 대화 기억에는 파일의 내용을 남기지 않는다 (다음 요청마다 다시 보내지 않게)
    saved = ctx.history_path(sid).read_text(encoding="utf-8")
    assert "대화 기억에서 뺐다" in saved and len(saved) < 30_000   # 파일의 내용은 들어가지 않는다
    remembered = [
        c for m in load_history(ctx.history_path(sid)) if isinstance(m, ModelRequest)
        for p in m.parts if isinstance(p, UserPromptPart) and not isinstance(p.content, str) for c in p.content
    ]
    assert remembered == []


# ------------------------------------------------------------------ 요약

async def test_summaries_are_the_agents_job(ctx, models, work):
    """요약은 저절로 생기지 않는다. 에이전트가 붙이고, 요약 도구는 보통 도구로도 묶음으로도 쓴다."""
    seen: list[str] = []
    models("test:agent", scripted([
        "알겠다.",
        call("write", path="입력", content="@include:원고/s1"),
        call("summarize"),                                             # 보통 도구로: 입력을 읽고 출력에 쓴다
        call("set_summary", target="원고/s1", from_output=True),
        call("set_summary", target="원고/s2", summary="에이전트의 요약"),   # 사용자가 쓴 요약은 덮지 않는다
        call("summarize_scenes", targets=["원고/s1", "원고/s2", "원고/s3", "원고/c1"]),
        call("summarize_scenes"),
        "끝.",
        "알겠다.",
        call("summarize_scenes"),
        "끝.",
    ]), seen)
    sid = work("auto")
    docs = ctx.docs(sid)
    m = docs.manuscript
    for text in ("바람이 불었다.", "비가 왔다.", "해가 떴다."):
        m.insert(text, by="user")
    m.set_scene("s2", summary="내가 쓴 요약")
    models("test:aux", ["서윤이 등탑에 오른다."])

    await run(ctx, sid, "읽어줘")
    assert "1.1 원고/s1 8자 — (요약 없음)" in seen[0]                       # 요청을 시작한다고 요약이 생기지 않는다
    assert not ctx.sessions.read_tool_call_log(sid)

    events = await run(ctx, sid, "요약을 붙여줘")
    out = results(events)
    assert out[1].startswith("'요약' 도구의 결과가 출력에 들어갔습니다") and out[2] == "1장 1번째 장면에 요약을 붙였습니다."
    assert docs.text(OUTPUT) == "서윤이 등탑에 오른다."                      # 출력은 그대로 둔다
    assert out[3].startswith("사용자가 직접 쓴 요약이 있어 그대로 두었습니다.")
    assert out[4] == "'요약' 도구로 3곳에 요약을 붙였습니다. 건너뛴 곳: 1장 2번째 장면(사용자가 쓴 요약)."
    assert out[5] == "요약할 장면이 없습니다. 요약이 없거나 낡은 장면이 없습니다."
    chapter = m.overview()["chapters"][0]
    assert [(s["summary"], s["summary_state"]) for s in chapter["scenes"]] == [
        ("서윤이 등탑에 오른다.", "ok"), ("내가 쓴 요약", "manual"), ("서윤이 등탑에 오른다.", "ok"),
    ]
    assert chapter["summary"] == "서윤이 등탑에 오른다."                    # 장의 요약은 장면 요약들을 재료로 만든다
    chapter_run = next(e for e in ctx.sessions.read_tool_call_log(sid) if e.get("target") == "원고/c1")
    assert chapter_run["input"].startswith("[1장의 장면 요약들]\n1. 서윤이 등탑에 오른다.")

    docs.apply(docs.plan_write("원고/s1", "찬 바람이 불었다."), by="user")   # 사용자가 고치면 요약이 낡는다

    def broken(messages):
        raise RuntimeError("보조 모델 없음")

    models("test:aux", broken)
    await run(ctx, sid, "다시 읽어줘")
    assert "(본문이 바뀐 뒤 요약을 고치지 않음)" in seen[-1]                 # 낡았다는 표시가 에이전트에게 보인다
    events = await run(ctx, sid, "요약을 고쳐줘")
    assert events[-1]["status"] == "completed"                           # 요약이 안 돼도 실행은 간다
    assert results(events)[0].startswith("요약을 붙인 곳이 없습니다. 실패한 곳 1곳 — 1장 1번째 장면: ")


async def test_summary_tool_can_be_missing_and_needs_approval_in_manual_mode(ctx, models, work):
    models("test:agent", scripted([call("summarize_scenes"), "끝.", call("summarize_scenes"), "끝.", call("summarize_scenes"), "끝."]))
    preset = test_preset()
    sid = work("manual", preset=preset.model_copy(update={"tools": preset.tools[:2]}))   # 요약 도구를 지운 프리셋
    m = ctx.docs(sid).manuscript
    m.insert("바람이 불었다.", by="user")
    events = await run(ctx, sid, "요약해줘")
    assert results(events)[0] == "오류: 요약 도구가 없습니다. 요약은 set_summary로 직접 붙일 수 있습니다."

    ctx.presets.save(preset)
    events = await run(ctx, sid, "요약해줘", ["반려"])                       # 수동 모드에서는 돌리기 전에 묻는다
    ask = asks(events)[0]
    assert (ask["kind"], ask["tool"], ask["input"]) == ("tool_confirm", "summarize", "1장 1번째 장면")
    assert results(events)[0] == "사용자가 반려했습니다. 요약을 붙이지 않았습니다." and m.stale() == ["s1"]
    events = await run(ctx, sid, "요약해줘", ["승인"])
    assert results(events)[0] == "'요약' 도구로 1곳에 요약을 붙였습니다." and m.stale() == []


# ------------------------------------------------------------------ 읽기 에이전트

async def test_explore_reads_for_the_agent_and_returns_only_the_answer(ctx, models, work):
    """많이 읽어야 하는 일은 읽기 에이전트가 보조 모델로 하고, 본 에이전트의 대화에는 답만 남는다."""
    from aleph.agent.history import load_history

    long_scene = "서윤은 등탑에 올랐다. " + "바람이 불었다. " * 400
    seen: list[str] = []
    prompts: list[str] = []

    def helper(messages):
        first = messages[0].parts[0].content
        if not prompts:
            prompts.append(first)
        done = sum(1 for m in messages if not isinstance(m, ModelRequest))
        return [call("read", path="원고/s1"), call("search", query="서윤"), "서윤은 1장 첫 장면에서 등탑에 오른다. (원고/s1)"][min(done, 2)]

    models("test:aux", helper, seen)
    models("test:agent", scripted([call("explore", task="서윤이 어디에 나오는지 알아봐 줘."), "서윤은 첫 장면에 나온다.", call("explore", task=" "), "끝."]))
    sid = work("plan")                                                     # 읽기만 하므로 계획 모드에서도 된다
    ctx.docs(sid).manuscript.insert(long_scene, by="user")

    events = await run(ctx, sid, "서윤이 어디에 나오지?")
    assert events[-1]["status"] == "completed"
    assert results(events) == ["서윤은 1장 첫 장면에서 등탑에 오른다. (원고/s1)"]
    assert next(e for e in events if e["type"] == "tool_call")["label"] == "읽기 에이전트"
    # 읽기 에이전트는 맡은 일과 지금의 목록을 받고, 읽기 도구만 쥔다
    assert "서윤이 어디에 나오는지 알아봐 줘." in prompts[0] and "[원고]" in prompts[0] and "읽기 에이전트입니다" in seen[0]
    # 무엇을 보고 있는지와 답이 화면으로 흘러간다
    stream = "".join(e["delta"] for e in events if e["type"] == "tool_stream")
    assert stream.startswith("읽기: 원고/s1\n찾기: 서윤\n") and stream.endswith("(원고/s1)")
    # 읽은 글은 본 에이전트의 대화 기억에 들어가지 않는다
    saved = ctx.history_path(sid).read_text(encoding="utf-8")
    assert "바람이 불었다. 바람이 불었다." not in saved and len(load_history(ctx.history_path(sid))) == 4
    # 사용량은 보조 호출로 남는다
    assert [c["tool"] for c in ctx.sessions.read_tool_call_log(sid)] == ["[explore]"]
    # 읽기 에이전트가 무엇을 봤는지는 기록에 남는다 (결과 이벤트와 도구 실행 기록). 본 에이전트에게는 답만 간다
    done = next(e for e in events if e["type"] == "tool_result")
    assert done["trail"] == ["읽기: 원고/s1", "찾기: 서윤"]
    logged = ctx.sessions.read_tool_call_log(sid)[0]
    assert (logged["task"], logged["trail"], logged["output"]) == ("서윤이 어디에 나오는지 알아봐 줘.", done["trail"], done["result"])
    assert results(await run(ctx, sid, "다시"))[0] == "오류: 알아볼 일이 비어 있습니다."


# ------------------------------------------------------------------ 제작 기록, 끊긴 실행

async def test_process_log_tells_what_happened_inside_and_between_runs(ctx, models, work):
    """제작 기록은 연구의 근거다. 대화의 구분, 묶음 요약이 붙인 글, 읽기 에이전트가 본 것, 압축의 내용이 다 나와야 한다."""
    from aleph.agent import compaction
    from aleph.agent.history import load_history, sanitize_history, save_history
    from aleph.process_log import compile_process_log

    def helper(messages):
        system = "".join(str(getattr(m, "instructions", "") or "") for m in messages)
        if "읽기 에이전트입니다" not in system:
            return "서윤이 등탑에 오른다."
        done = sum(1 for m in messages if not isinstance(m, ModelRequest))
        return [call("read", path="원고/s1"), "서윤은 첫 장면에 나온다. (원고/s1)"][min(done, 1)]

    models("test:aux", helper)
    models("test:agent", scripted([
        call("write", path="입력", content="지시서"), call("compose"), call("insert_scene", from_output=True),
        call("summarize_scenes"), "첫 장면을 썼다.",
        call("explore", task="서윤이 어디에 나오는지 알아봐 줘."), "첫 장면에 나온다.",
    ]))
    sid = work("autonomous")
    await run(ctx, sid, "첫 장면을 써줘")
    other = ctx.sessions.create_conversation(sid)["id"]
    ctx.runs.start(sid, ctx.run_config(sid, goal="서윤이 어디에 나오지?", conversation=other))   # 둘째 요청은 새 대화에서
    await collect(ctx, sid)

    # 첫 대화를 손으로 압축한 것처럼 기록을 남긴다 (실행 밖에서 일어나는 일)
    ctx.sessions.append_event(sid, {
        "type": "compaction", "manual": True, "conversation_id": "main", "kind": "summary", "dropped_messages": 7,
        "tokens_before": 900, "tokens_after": 200, "summary": "첫 장면을 썼고 요약을 붙였다.",
    })
    log = compile_process_log(ctx.sessions, sid)
    assert "- 총 실행: 2회" in log and "(목표 미상)" not in log                # 실행 밖의 일은 실행으로 세지 않는다
    assert "- 대화: 2개" in log and "- 대화: 첫 장면을 써줘 (`main`)" in log
    assert f"- 대화: 서윤이 어디에 나오지? (`{other}`)" in log               # 실행마다 어느 대화의 것인지 적힌다
    assert "  - 원고/s1 (`test:aux`): 서윤이 등탑에 오른다." in log           # 묶음 요약이 장면에 붙인 글
    assert "  - 읽기 에이전트가 본 것 (`test:aux`): 읽기: 원고/s1" in log
    assert "### 실행 사이" in log and "사용자가 `지금 압축`을 눌러 앞선 메시지 7개를 요약으로 바꿨다 (900 → 200 토큰)" in log
    assert "첫 장면을 썼고 요약을 붙였다." in log                              # 에이전트가 앞부분 대신 들고 있는 글
    assert log.count("<summary>지침과 도구 지시문 (전문)</summary>") == 1 and "지침과 도구 지시문은 실행 1과 같다." in log
    assert "**앱이 지침 앞에 붙이는 글**" in log and "<workspace>" in log     # 화면에 안 보이는 글도 기록에는 남는다


def test_runs_cut_off_by_a_shutdown_are_closed_on_the_next_start(tmp_path):
    """창을 닫거나 컴퓨터가 꺼져서 끊긴 실행은, 다시 켤 때 끝났다는 표시를 붙인다."""
    from aleph.context import AppContext
    from aleph.settings import AppPaths

    paths = AppPaths(data=tmp_path / "data")
    ctx = AppContext(paths)
    sid = ctx.create_session("끊긴 작업")["id"]
    other = ctx.sessions.create_conversation(sid)["id"]
    for cid, events in {
        "main": [{"type": "run_started", "run_id": "r1"}, {"type": "done", "run_id": "r1", "status": "completed"},
                 {"type": "run_started", "run_id": "r2"}, {"type": "tool_call", "run_id": "r2", "tool": "compose"}],
        other: [{"type": "run_started", "run_id": "r0"}, {"type": "done", "run_id": "r0", "status": "completed"}],
    }.items():
        for e in events:
            ctx.sessions.append_event(sid, e, cid)

    again = AppContext(paths)                                              # 엔진을 다시 켠다
    last = again.sessions.read_events(sid, "main")[-1]
    assert (last["type"], last["status"], last["run_id"], last["conversation_id"]) == ("done", "interrupted", "r2", "main")
    assert again.sessions.read_events(sid, other)[-1]["status"] == "completed"   # 끝난 대화는 건드리지 않는다
    assert len(AppContext(paths).sessions.read_events(sid, "main")) == 5         # 두 번 붙이지 않는다


# ------------------------------------------------------------------ 이미지 모델

async def test_images_are_made_by_a_separate_image_model(ctx, models, work):
    """그림은 에이전트 모델이 아니라 프리셋의 이미지 모델이 만든다. 에이전트는 무엇을 그릴지 글로 써서 넘긴다."""
    from pydantic_ai.messages import BinaryContent, BinaryImage, FilePart, ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    from aleph.providers.factory import register_test_model

    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    got: list[list] = []

    def painter(messages, info):
        parts = messages[-1].parts[0].content
        got.append([p if isinstance(p, str) else p.media_type for p in (parts if isinstance(parts, list) else [parts])])
        if "거절" in str(parts):
            return ModelResponse(parts=[TextPart(content="그릴 수 없는 내용이다.")])
        return ModelResponse(parts=[FilePart(content=BinaryImage(data=png, media_type="image/png"))])

    register_test_model("test:painter", FunctionModel(painter, profile={"supports_image_output": True}))
    register_test_model("test:writer_only", FunctionModel(painter))          # 그림을 못 만드는 모델

    # 이미지 모델이 없는 프리셋에서는 그 도구가 아예 없다. 계획 모드에서도 없다
    names = lambda **kw: {t.name for t in build_agent_tools(**kw)}  # noqa: E731
    assert "generate_image" not in names(mode="auto") and "generate_image" in names(mode="auto", image=True)
    assert "generate_image" not in names(mode="plan", image=True)

    models("test:agent", scripted([
        call("generate_image", prompt="폭풍이 치는 밤의 등대. 수채화.", name="등탑의 밤"),
        call("generate_image", prompt="같은 등대의 아침.", name="등탑의 밤", references=["자료/삽화/등탑의 밤.png"]),
        call("generate_image", prompt="거절당할 그림"),
        call("generate_image", prompt="x", references=["자료/계획"]),
        "그렸다.",
        call("generate_image", prompt="아침의 식탁."), "끝.",
        call("generate_image", prompt="아침의 식탁."), "끝.",
        call("generate_image", prompt="등대."), "끝.",
    ]))
    sid = work("autonomous", image_model="test:painter")
    docs = ctx.docs(sid)
    events = await run(ctx, sid, "삽화를 그려줘")
    out = results(events)
    assert out[0] == "이미지를 '자료/삽화/등탑의 밤.png'에 저장했습니다. 원고에 넣으려면 그 자리에 ![설명](자료/삽화/등탑의 밤.png)라고 적습니다."
    assert out[1].startswith("이미지를 '자료/삽화/등탑의 밤 2.png'에 저장했습니다.")       # 같은 이름이 있으면 번호가 붙는다
    assert out[2] == "이미지 모델이 그림을 내지 않았습니다. 모델의 말: 그릴 수 없는 내용이다."
    assert out[3] == "오류: '자료/계획'은 자료에 있는 그림이 아닙니다."
    assert docs.get_bytes("자료/삽화/등탑의 밤.png") == png and docs.history("자료/삽화/등탑의 밤.png")[0]["by"] == "agent"
    assert got[0] == ["폭풍이 치는 밤의 등대. 수채화."] and got[1] == ["같은 등대의 아침.", "image/png"]   # 앞의 그림을 같이 보인다
    changed = [e["changed"] for e in events if e["type"] == "tool_result"]
    assert changed[0] == ["자료/삽화/등탑의 밤.png"] and changed[2] == []
    calls = next(e for e in events if e["type"] == "tool_call")
    assert calls["label"] == "이미지 만들기"
    logged = [c for c in ctx.sessions.read_tool_call_log(sid) if c["tool"] == "[image]"]
    assert [(c["model"], c["output"]) for c in logged] == [
        ("test:painter", "자료/삽화/등탑의 밤.png"), ("test:painter", "자료/삽화/등탑의 밤 2.png"), ("test:painter", "그릴 수 없는 내용이다."),
    ]

    # 수동 모드에서는 만들기 전에 넘길 글을 보여 주고 묻는다
    ctx.set_state(sid, mode="manual")
    events = await run(ctx, sid, "한 장 더", ["반려"])
    ask = asks(events)[0]
    assert (ask["kind"], ask["label"], ask["input"]) == ("tool_confirm", "이미지 만들기", "아침의 식탁.")
    assert results(events)[0] == "사용자가 반려했습니다. 이미지를 만들지 않았습니다."
    assert results(await run(ctx, sid, "한 장 더", ["승인"]))[0].startswith("이미지를 '자료/삽화/만든 그림.png'에 저장했습니다.")

    # 그림을 못 만드는 모델을 이미지 모델로 두면 그렇다고 알린다
    ctx.set_state(sid, mode="autonomous")
    ctx.presets.save(ctx.presets.get("t").model_copy(update={"image_model": "test:writer_only"}))
    assert results(await run(ctx, sid, "또"))[0].startswith("오류: 'test:writer_only'는 그림을 만드는 모델이 아닙니다.")
