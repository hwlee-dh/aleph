"""요청 단위로 되돌리기, 새 대화."""

from __future__ import annotations

import httpx
import pytest
from pydantic_ai.messages import ModelRequest

from aleph.app import create_app
from aleph.workspace import undo
from tests.conftest import results, run, scripted


def call(tool: str, **args) -> dict:
    return {"tool": tool, "args": args}


def prepare(ctx, sid: str) -> None:
    """실행 전에 사용자가 만들어 둔 것들."""
    docs = ctx.docs(sid)
    for path, content in [("자료/계획", "원래 계획"), ("자료/버릴 메모", "버릴 것"), ("자료/옛 이름", "옮길 것")]:
        docs.apply(docs.plan_write(path, content), by="user")
    docs.manuscript.insert("기존 장면.", by="user")
    docs.manuscript.insert("둘째 장면.", by="user")


BUSY_RUN = [
    call("write", path="자료/인물/서윤", content="등대지기의 딸"),          # 새로 만든다
    call("edit", path="자료/계획", old_text="원래", new_text="고친"),       # 고친다
    call("delete", path="자료/버릴 메모"),                                  # 지운다
    call("move", source="자료/옛 이름", destination="자료/새 이름"),         # 옮긴다
    call("set_note", path="자료/계획"),                                     # 설정을 바꾼다
    call("write", path="입력", content="지시서"),
    call("compose"),
    call("insert_scene", from_output=True, after="s1"),     # 원고에 넣는다
    call("edit", path="원고/s1", old_text="기존", new_text="고친"),          # 있던 장면을 고친다
    call("move_scene", scene="원고/s2", at_start=True, chapter=1),           # 순서를 바꾼다
    "다 했다.",
]


async def test_revert_puts_everything_back(ctx, models, work):
    models("test:agent", scripted(BUSY_RUN))
    sid = work("autonomous")
    prepare(ctx, sid)
    docs = ctx.docs(sid)
    before_docs = {p: docs.get(p) for p in docs.paths()}
    before_index = [s["id"] for c in docs.manuscript.overview()["chapters"] for s in c["scenes"]]
    assert undo.last_run(ctx.sessions, sid, running=False)["reason"] == "되돌릴 기록이 없습니다."

    events = await run(ctx, sid, "이것저것 해줘")
    assert all(not r.startswith("오류") for r in results(events)), results(events)
    run_id = events[0]["run_id"]
    assert docs.manuscript.scene_ids() == ["s2", "s1", "s3"] and docs.noted("자료/계획.md")
    assert ctx.history_path(sid).exists()

    info = undo.last_run(ctx.sessions, sid, running=False)
    assert (info["run_id"], info["kind"], info["goal"], info["status"], info["revertible"]) == (run_id, "agent", "이것저것 해줘", "completed", True)
    titles = {c["path"]: c["title"] for c in info["changes"]}
    assert titles["원고/s3"] == "1장 3번째 장면" and titles["자료/버릴 메모"] == "버릴 메모" and titles["출력"] == "출력"
    assert {(c["path"], c["action"]) for c in info["changes"]} == {
        ("자료/인물/서윤", "write"), ("자료/계획", "write"), ("자료/버릴 메모", "delete"), ("자료/새 이름", "move"),
        ("입력", "write"), ("출력", "write"), ("원고/s3", "write"), ("원고/s1", "write"),
    }
    assert info["touched_later"] == []

    done = undo.revert(ctx.sessions, sid, run_id)
    assert done["kept"] == [] and "자료/인물/서윤" in done["reverted"] and "원고/s3" in done["reverted"]
    assert {p: docs.get(p) for p in docs.paths()} == before_docs           # 문서가 전부 실행 전과 같다
    assert [s["id"] for c in docs.manuscript.overview()["chapters"] for s in c["scenes"]] == before_index
    assert not docs.noted("자료/계획.md") and not ctx.history_path(sid).exists()   # 설정과 대화 기억도
    assert docs.history("자료/계획")[-1]["origin"] == {"reverted_run": run_id} and docs.history("자료/계획")[-1]["by"] == "user"
    last = ctx.sessions.read_events(sid)[-1]
    assert (last["type"], last["target_run_id"]) == ("reverted", run_id)

    info = undo.last_run(ctx.sessions, sid, running=False)
    assert (info["revertible"], info["reason"]) == (False, "이미 되돌렸습니다.")
    with pytest.raises(undo.RevertError, match="이미 되돌렸습니다"):
        undo.revert(ctx.sessions, sid, run_id)


async def test_revert_keeps_what_the_user_touched_afterwards(ctx, models, work):
    models("test:agent", scripted(BUSY_RUN))
    sid = work("autonomous")
    prepare(ctx, sid)
    docs = ctx.docs(sid)
    events = await run(ctx, sid, "이것저것 해줘")
    run_id = events[0]["run_id"]

    # 실행이 끝난 뒤 사용자가 직접 손댄 것: 에이전트가 고친 문서 하나, 에이전트가 만든 장면 하나, 그리고 새 장면
    docs.apply(docs.plan_write("자료/계획", "내가 다시 고친 계획"), by="user")
    docs.apply(docs.plan_write("원고/s3", "내가 고쳐 쓴 새 장면."), by="user")
    mine = docs.manuscript.insert("내가 쓴 장면.", by="user")

    info = undo.last_run(ctx.sessions, sid, running=False)
    assert info["revertible"] and info["touched_later"] == ["자료/계획", "원고/s3"]
    with pytest.raises(undo.RevertError) as error:
        undo.revert(ctx.sessions, sid, run_id)
    assert error.value.touched_later == ["원고/s3", "자료/계획"] and docs.get("자료/인물/서윤.md") == "등대지기의 딸"   # 아무것도 안 바뀌었다

    done = undo.revert(ctx.sessions, sid, run_id, force=True)
    assert done["kept"] == ["원고/s3", "자료/계획"]
    assert docs.get("자료/계획.md") == "내가 다시 고친 계획" and docs.manuscript.content("s3") == "내가 고쳐 쓴 새 장면."
    assert not docs.exists("자료/인물/서윤.md") and docs.get("자료/버릴 메모.md") == "버릴 것" and docs.get("자료/옛 이름.md") == "옮길 것"
    assert docs.manuscript.content("s1") == "기존 장면."
    scenes = [s["id"] for c in docs.manuscript.overview()["chapters"] for s in c["scenes"]]
    assert scenes == ["s1", "s2", "s3", mine]   # 순서는 실행 전으로, 남긴 장면은 뒤에


async def test_structure_only_and_direct_tool_runs_can_be_reverted(ctx, models, work):
    models("test:agent", scripted([call("move_scene", scene="원고/s2", at_start=True, chapter=1), "옮겼다."]))
    sid = work("autonomous")
    prepare(ctx, sid)
    docs = ctx.docs(sid)
    events = await run(ctx, sid, "둘째 장면을 앞으로")
    info = undo.last_run(ctx.sessions, sid, running=False)
    assert info["changes"] == [{"path": "원고", "action": "structure", "title": "원고의 순서"}] and info["revertible"]   # 글은 그대로, 순서만 바뀜
    undo.revert(ctx.sessions, sid, events[0]["run_id"])
    assert docs.manuscript.scene_ids() == ["s1", "s2"]

    # 사용자가 도구를 직접 돌린 것도 실행 하나다. 되돌리면 출력이 그 전으로 돌아간다
    docs.apply(docs.plan_write("입력", "지시서"), by="user")
    docs.apply(docs.plan_write("출력", "남겨 둔 초고"), by="user")
    events = await run(ctx, sid, "/집필", tool="compose", kind="tool")
    assert docs.text("출력") == "바람이 불었다."
    info = undo.last_run(ctx.sessions, sid, running=False)
    assert (info["kind"], info["changes"]) == ("tool", [{"path": "출력", "action": "write", "title": "출력"}])
    undo.revert(ctx.sessions, sid, events[0]["run_id"])
    assert docs.text("출력") == "남겨 둔 초고"

    # 그 실행이 지운 장면은 지금 원고에 없으므로 자리로 부를 수 없다
    models("test:agent", scripted([call("delete", path="원고/s2"), "지웠다."]))
    await run(ctx, sid, "둘째 장면을 지워줘")
    assert undo.last_run(ctx.sessions, sid, running=False)["changes"] == [{"path": "원고/s2", "action": "delete", "title": "지운 장면"}]

    # 바꾼 것이 없는 실행은 되돌릴 것이 없다
    models("test:agent", scripted(["그냥 대답."]))
    await run(ctx, sid, "안녕")
    assert undo.last_run(ctx.sessions, sid, running=False)["reason"] == "이 실행이 바꾼 것이 없습니다."


async def test_new_conversation_keeps_documents(ctx, models, work):
    seen: list[int] = []

    def script(messages):
        seen.append(sum(1 for m in messages if isinstance(m, ModelRequest)))
        return "알겠다."

    models("test:agent", script)
    sid = work("auto")
    prepare(ctx, sid)
    await run(ctx, sid, "첫 요청")
    await run(ctx, sid, "둘째 요청")
    assert seen == [1, 2] and ctx.sessions.conversation(sid, "main")["context_tokens"] > 0     # 대화가 쌓인다

    undo.reset_conversation(ctx.sessions, sid)
    assert not ctx.history_path(sid).exists() and ctx.sessions.conversation(sid, "main")["context_tokens"] == 0
    assert len(list(ctx.sessions.path(sid).glob("history-*.json"))) == 1          # 앞의 기억은 지우지 않고 따로 둔다
    assert ctx.sessions.read_events(sid)[-1]["type"] == "conversation_reset"
    assert undo.last_run(ctx.sessions, sid, running=False)["revertible"] is False
    assert ctx.docs(sid).get("자료/계획.md") == "원래 계획"                        # 문서는 그대로

    await run(ctx, sid, "새 대화의 첫 요청")
    assert seen[-1] == 1                                                         # 에이전트는 앞의 대화를 모른다


async def test_undo_over_http(ctx, models, work):
    models("test:agent", scripted([call("write", path="자료/인물/서윤", content="등대지기의 딸"), "썼다."]))
    sid = work("autonomous")
    app = create_app(ctx.paths)
    app.state.ctx = ctx
    base = f"/api/sessions/{sid}"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        empty = (await http.get(f"{base}/runs/last")).json()
        assert empty["run_id"] is None and empty["revertible"] is False

        events = await run(ctx, sid, "인물을 적어줘")
        run_id = events[0]["run_id"]
        info = (await http.get(f"{base}/runs/last")).json()
        assert info["run_id"] == run_id and info["changes"] == [{"path": "자료/인물/서윤", "action": "write", "title": "인물/서윤"}]
        assert (await http.post(f"{base}/runs/없는실행/revert", json={})).status_code == 409

        await http.put(f"{base}/docs/content", json={"path": "자료/인물/서윤", "content": "내가 고침"})
        blocked = await http.post(f"{base}/runs/{run_id}/revert", json={})
        assert blocked.status_code == 409 and blocked.json()["touched_later"] == ["자료/인물/서윤"]
        forced = (await http.post(f"{base}/runs/{run_id}/revert", json={"force": True})).json()
        assert forced == {"reverted": [], "kept": ["자료/인물/서윤"]}
        assert (await http.get(f"{base}/events")).json()["events"][-1]["type"] == "reverted"

        assert (await http.post(f"{base}/conversation/reset")).json() == {"status": "ok", "conversation_id": "main"}
        assert (await http.get(f"{base}/workspace")).json()["context"]["tokens"] == 0
