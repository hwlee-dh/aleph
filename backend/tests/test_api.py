"""HTTP API — 화면이 쓰는 경로를 처음부터 끝까지. 명세는 backend/API.md."""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from urllib.parse import unquote

import httpx
import pytest

from aleph.app import create_app
from aleph.providers.factory import register_test_model
from aleph.workspace.documents import content_hash
from aleph.settings import AppPaths
from tests.conftest import basic_preset, scripted, scripted_model


@pytest.fixture
async def client(tmp_path):
    app = create_app(AppPaths(data=tmp_path / "data"))
    app.state.ctx.presets.save(basic_preset())   # 앱에 같이 들어 있는 프리셋은 없다. 테스트가 쓸 것을 하나 넣어 둔다
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        c.app = app
        yield c
    await app.state.ctx.runs.shutdown()


def sse_events(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if line.startswith("data: ") and line != "data: [DONE]":
            out.append(json.loads(line[6:]))
    return out


def fake(ref: str, script) -> None:
    register_test_model(ref, scripted_model(script))


async def new_work(client, name: str = "작업", **state) -> str:
    """넣어 둔 프리셋(`basic`)에 가짜 모델을 적고 그 프리셋으로 작업을 만든다. 모델은 프리셋에만 있다."""
    for ref, script in [("test:agent", ["끝."]), ("test:aux", ["요약이다."])]:
        fake(ref, script)
    # 도구가 에이전트와 같은 가짜 모델을 쓰면 대본이 섞인다. 집필과 비평에는 따로 모델을 준다.
    # 요약 도구는 모델을 비워 둔다. 그러면 보조 모델(test:aux)로 돈다.
    fake("test:writer", ["바람이 불었다."])
    preset = (await client.get("/api/presets/basic")).json()
    for tool in preset["tools"]:
        tool["model"] = "" if tool["name"] == "summarize" else "test:writer"
    await client.put("/api/presets/basic", json={**preset, "model": "test:agent", "auxiliary_model": "test:aux"})
    sid = (await client.post("/api/sessions", json={"name": name, "preset_id": "basic"})).json()["id"]
    if state:
        await client.put(f"/api/sessions/{sid}/state", json=state)
    return sid


def call(tool: str, **args) -> dict:
    return {"tool": tool, "args": args}


# ------------------------------------------------------------------ 설정과 제공자

async def test_meta_and_providers(client, monkeypatch):
    for name in ("GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "VERTEX_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    meta = (await client.get("/api/meta")).json()
    assert {k["id"] for k in meta["provider_kinds"]} >= {"google", "anthropic", "vertex", "openai", "openrouter", "ollama"}
    assert {k["id"] for k in meta["provider_kinds"] if k["tested"]} == {"google", "anthropic", "vertex"}
    assert [m["id"] for m in meta["modes"]] == ["manual", "auto", "autonomous", "plan"]
    assert {"name": "insert_scene", "label": "원고에 넣기"} in meta["agent_tools"]
    # 앱이 지침 앞에 붙이는 글은 화면에 내주지 않는다. 요약 도구를 다시 넣을 때 채울 글은 내준다.
    assert "base_instruction" not in meta
    assert (meta["summary_tool"]["name"], meta["summary_tool"]["label"]) == ("summarize", "요약") and "한두 문장" in meta["summary_tool"]["prompt"]

    providers = (await client.get("/api/providers")).json()["providers"]
    google = next(p for p in providers if p["id"] == "google")
    assert google["has_key"] is False and google["ready"] is False
    assert next(p for p in providers if p["id"] == "ollama")["ready"] is True  # 로컬은 키가 필요 없다

    r = await client.put("/api/providers/google", json={"kind": "google", "api_key": "secret-123"})
    assert r.status_code == 200
    body = r.json()
    assert body["has_key"] and body["key_source"] == "config" and "secret-123" not in r.text
    assert "secret-123" not in (await client.get("/api/providers")).text

    # 키를 비워 보내면 기존 키가 유지된다 (주소만 고치는 경우)
    r = await client.put("/api/providers/google", json={"kind": "google", "label": "내 구글"})
    assert r.json()["has_key"] and r.json()["label"] == "내 구글"
    assert (await client.delete("/api/providers/google/key")).json()["has_key"] is False

    r = await client.put("/api/providers/my-server", json={"kind": "openai_compatible", "base_url": "http://localhost:9999/v1"})
    assert r.status_code == 200 and r.json()["tested"] is False
    # 저장해도 목록에서의 자리는 그대로다
    order = [p["id"] for p in (await client.get("/api/providers")).json()["providers"]]
    await client.put(f"/api/providers/{order[0]}", json={"kind": order[0], "label": "고친 이름"})
    assert [p["id"] for p in (await client.get("/api/providers")).json()["providers"]] == order
    assert (await client.put("/api/providers/Bad Id", json={"kind": "google"})).status_code == 400

    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    providers = (await client.get("/api/providers")).json()["providers"]
    assert next(p for p in providers if p["id"] == "anthropic")["key_source"] == "env"


# ------------------------------------------------------------------ 프리셋

async def test_presets(client):
    listed = (await client.get("/api/presets")).json()["presets"]
    assert listed == [{"id": "basic", "name": "기본", "description": "테스트용 프리셋."}]
    preset = (await client.get("/api/presets/basic")).json()
    original = json.loads(json.dumps(preset))
    assert [(t["name"], t["label"]) for t in preset["tools"]] == [("compose", "집필"), ("critique", "비평"), ("summarize", "요약")]
    assert set(preset) == {
        "id", "name", "description", "instruction", "tools",
        "model", "temperature", "thinking", "max_output_tokens", "context_budget",
        "auxiliary_model", "auxiliary_temperature", "auxiliary_thinking", "auxiliary_max_output_tokens", "auxiliary_max_input_tokens",
        "image_model", "start_mode", "web_search", "web_fetch",
    }
    # 따로 정하지 않은 칸은 모델의 기본값을 따른다
    assert (preset["model"], preset["auxiliary_model"], preset["temperature"], preset["context_budget"]) == ("", "", None, 150000)
    assert (preset["web_search"], preset["web_fetch"]) == (False, False)
    assert set(preset["tools"][0]) == {"name", "label", "description", "prompt", "model", "temperature", "thinking", "max_tokens", "enabled"}

    # 고치면 그 프리셋이 바뀐다 (사본이 따로 생기지 않는다)
    preset["instruction"] = "고친 지침"
    preset["tools"].append({"label": "줄거리 짜기", "description": "입력의 설정으로 줄거리를 짠다.", "prompt": "당신은 구성 작가다."})
    saved = (await client.put("/api/presets/basic", json=preset)).json()
    assert saved["tools"][3]["name"] == "tool_1"                                    # 영문 이름은 서버가 정한다
    assert (await client.get("/api/presets/basic")).json()["instruction"] == "고친 지침"
    assert len((await client.get("/api/presets")).json()["presets"]) == 1
    await client.put("/api/presets/basic", json=original)

    # 칸 몇 개만 고치기 (채팅창에서 모델을 바꿀 때). 다른 칸은 그대로 남고, 숫자는 쓸 수 있는 범위로 맞춰진다
    patched = (await client.patch("/api/presets/basic", json={"model": "test:agent", "temperature": 5, "max_output_tokens": 0})).json()
    assert (patched["model"], patched["temperature"], patched["max_output_tokens"], patched["instruction"]) == (
        "test:agent", 2.0, None, original["instruction"],
    )
    assert (await client.patch("/api/presets/basic", json={"id": "x"})).status_code == 400
    assert (await client.patch("/api/presets/basic", json={"thinking": "아무거나"})).status_code in (400, 422)
    assert (await client.patch("/api/presets/없음", json={"model": "x"})).status_code == 404
    await client.put("/api/presets/basic", json=original)

    # 화면은 고치는 족족 저장한다. 쓰다 만 도구(지시문이 빈 것, 화면이 지어 보낸 임시 이름)도 받는다
    draft = {**preset, "tools": [*preset["tools"][:2], {"name": "tool_a1b2c3", "label": "새 도구", "prompt": ""}]}
    saved = (await client.put("/api/presets/mine", json=draft)).json()
    assert [(t["name"], t["prompt"] != "") for t in saved["tools"]] == [("compose", True), ("critique", True), ("tool_a1b2c3", False)]
    r = await client.put("/api/presets/mine", json={**preset, "tools": [{"name": "same", "prompt": "a"}, {"name": "same", "prompt": "b"}]})
    assert r.status_code == 400 and "영문 이름이 겹칩니다" in r.json()["error"]
    assert (await client.delete("/api/presets/mine")).json() == {"status": "deleted"}
    assert (await client.delete("/api/presets/mine")).status_code == 404

    # 복제(다른 이름으로 저장)는 새 id를 받는다. 있던 것을 덮어쓰지 않는다
    copy = (await client.post("/api/presets/basic/duplicate", json={"name": "내 방식"})).json()
    assert (copy["id"], copy["name"]) == ("basic_copy", "내 방식")
    second = (await client.post("/api/presets/basic/duplicate", json={})).json()
    third = (await client.post("/api/presets/basic/duplicate", json={})).json()
    assert (second["id"], second["name"]) == ("basic_copy_2", "기본 사본")
    assert (third["id"], third["name"]) == ("basic_copy_3", "기본 사본 2")          # 같은 이름이 있으면 번호를 붙인다
    assert (await client.delete("/api/presets/basic_copy_3")).json()["status"] == "deleted"


def packed_preset(files: dict[str, str], manifest: dict | None = None) -> bytes:
    """손으로 만든 `.alephpreset`."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("aleph.json", json.dumps({"app": "ALEPH", "kind": "preset", "format": 1, **(manifest or {})}))
        for name, content in files.items():
            z.writestr(name, content)
    return buffer.getvalue()


async def test_preset_file_export_and_import(client):
    preset = (await client.get("/api/presets/basic")).json()
    mine = {
        **preset, "name": "내 방식: 초안", "instruction": "고친 지침",
        "model": "google:gemini-x", "temperature": 0.7, "thinking": "high", "max_output_tokens": 9000, "context_budget": 80000,
        "auxiliary_model": "google:gemini-y", "auxiliary_temperature": 0.3, "auxiliary_thinking": "off",
        "auxiliary_max_output_tokens": 4000, "auxiliary_max_input_tokens": 50000, "web_search": True,
        "tools": [*preset["tools"], {"label": "줄거리 짜기", "description": "d", "prompt": "당신은 구성 작가다.", "enabled": False}],
    }
    saved = (await client.put("/api/presets/mine", json=mine)).json()

    packed = await client.get("/api/presets/mine/archive")
    assert packed.status_code == 200 and packed.headers["content-type"] == "application/octet-stream"
    assert unquote(packed.headers["content-disposition"]).endswith("내 방식 초안.alephpreset")   # 파일 이름에 못 쓰는 글자는 뺀다
    with zipfile.ZipFile(io.BytesIO(packed.content)) as z:       # 속은 zip이고, 열어서 고칠 수 있는 파일들이다
        assert set(z.namelist()) == {
            "aleph.json", "preset.yaml", "instruction.md",
            "tools/compose.md", "tools/critique.md", "tools/summarize.md", "tools/tool_1.md",
        }
        manifest = json.loads(z.read("aleph.json"))
        assert (manifest["app"], manifest["kind"], manifest["format"], manifest["id"]) == ("ALEPH", "preset", 1, "mine")
        assert z.read("instruction.md").decode("utf-8") == "고친 지침" and "당신은 구성 작가다." in z.read("tools/tool_1.md").decode("utf-8")
    assert (await client.get("/api/presets/없음/archive")).status_code == 404

    # 가져오면 새 id와 구분되는 이름으로 들어온다. 내용은 그대로다
    got = (await client.post("/api/import", content=packed.content)).json()
    assert got["kind"] == "preset"
    back = got["preset"]
    assert (back["id"], back["name"]) == ("mine_2", "내 방식: 초안 2")
    # 모델 설정도 프리셋과 같이 간다 (받는 쪽에 그 제공자가 없어도 그대로 적혀 온다)
    same = (
        "instruction", "tools", "web_search",
        "model", "temperature", "thinking", "max_output_tokens", "context_budget",
        "auxiliary_model", "auxiliary_temperature", "auxiliary_thinking", "auxiliary_max_output_tokens", "auxiliary_max_input_tokens",
    )
    assert {k: back[k] for k in same} == {k: saved[k] for k in same}
    assert (await client.get("/api/presets/mine")).json()["name"] == "내 방식: 초안"      # 있던 것은 그대로
    assert len((await client.get("/api/presets")).json()["presets"]) == SHIPPED + 2

    # 사람이 열어서 고친 파일: 머리말에 이름이 없는 도구는 파일 이름을 쓰고, 쓸 수 없는 이름이면 새로 정한다
    tool = "---\nlabel: 퇴고\n---\n\n문장을 다듬는다.\n"
    by_hand = packed_preset({
        "preset.yaml": "name: 손으로 만든 것\ntemperature: 5\nmax_output_tokens: -3\n",
        "tools/polish.md": tool, "tools/write.md": tool, "tools/..\\..\\밖.md": tool,
        "../../밖.md": "x", "메모.md": "프리셋에 속하지 않는 파일",
    }, {"id": "손 hand made"})
    made = (await client.post("/api/import", content=by_hand)).json()["preset"]
    assert (made["id"], made["name"], made["temperature"], made["max_output_tokens"]) == ("hand_made", "손으로 만든 것", 2.0, None)
    assert sorted(t["name"] for t in made["tools"]) == ["polish", "tool_1"]
    data_dir = client.app.state.ctx.paths.data
    assert not list(data_dir.rglob("밖.md")) and not (data_dir.parent / "밖.md").exists()

    # 읽을 수 없는 것은 이유와 함께 거절한다
    for bad, message in [
        (b"not a zip", "내보낸 파일이 아닙니다"),
        (json.dumps(saved).encode("utf-8"), "내보낸 파일이 아닙니다"),                       # zip이 아닌 JSON
        (packed_preset({"instruction.md": "지침만"}), "preset.yaml이 없습니다"),
        (packed_preset({"preset.yaml": "name: x"}, {"format": 99}), "읽을 수 없는 파일"),
        (packed_preset({"preset.yaml": "- 목록"}), "이름: 값"),
        (packed_preset({"preset.yaml": "name: x", "tools/bad.md": "머리말이 없다"}), "도구 파일 bad.md"),
    ]:
        r = await client.post("/api/import", content=bad)
        assert r.status_code == 400 and message in r.json()["error"], (message, r.json())
    assert len((await client.get("/api/presets")).json()["presets"]) == SHIPPED + 3


SHIPPED = 1   # 테스트가 넣어 둔 프리셋의 수 (`basic`)

# ------------------------------------------------------------------ 작업과 상태

async def test_no_preset_ships_with_the_app(tmp_path):
    """앱에 같이 들어 있는 프리셋은 없다. 프리셋을 고르지 않고 작업을 만들면 그 작업의 이름으로 빈 프리셋이 생긴다."""
    app = create_app(AppPaths(data=tmp_path / "빈 데이터"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        assert (await http.get("/api/presets")).json() == {"presets": []}
        made = (await http.post("/api/sessions", json={"name": "등대"})).json()
        preset = (await http.get(f"/api/presets/{made['preset_id']}")).json()
        assert (preset["id"], preset["name"], preset["instruction"], preset["tools"], preset["model"]) == ("preset", "등대", "", [], "")
        ws = (await http.get(f"/api/sessions/{made['id']}/workspace")).json()
        assert ws["state"]["preset_id"] == "preset" and ws["state"]["effective_model"] == ""
        # 시작 자료는 프리셋과 상관없이 새 작업마다 깔린다
        assert [(m["path"], m["note"], m["by"]) for m in ws["materials"]] == [
            ("자료/단기 계획.md", True, "starter"), ("자료/작품 노트.md", True, "starter"), ("자료/장기 계획.md", True, "starter"),
        ]
        doc = (await http.get(f"/api/sessions/{made['id']}/docs/content", params={"path": "자료/장기 계획"})).json()
        assert doc["content"] == "# 장기 계획\n"
        r = await http.post(f"/api/sessions/{made['id']}/runs", json={"goal": "써줘"})
        assert r.status_code in (400, 422) and r.json()["error"].endswith("니다.")          # 모델을 고르지 않았다

        # 빈 프리셋을 따로 만들 수도 있다. 같은 이름이 있으면 번호가 붙는다
        blank = (await http.post("/api/presets", json={})).json()
        again = (await http.post("/api/presets", json={"name": "등대"})).json()
        assert (blank["id"], blank["name"]) == ("preset_2", "새 프리셋") and (again["id"], again["name"]) == ("preset_3", "등대 2")

        # 프리셋을 다 지우면 작업은 프리셋 없이 남는다. 다시 만들거나 가져와서 고르면 된다
        for p in (await http.get("/api/presets")).json()["presets"]:
            assert (await http.delete(f"/api/presets/{p['id']}")).status_code == 200
        assert (await http.get(f"/api/sessions/{made['id']}/state")).json()["preset_id"] == ""
        r = await http.post(f"/api/sessions/{made['id']}/runs", json={"goal": "써줘"})
        assert r.status_code in (400, 422) and "프리셋이 없습니다" in r.json()["error"]
    await app.state.ctx.runs.shutdown()


async def test_a_preset_can_set_the_mode_new_works_start_in(client):
    """프리셋의 시작 모드: 그 프리셋으로 만든 작업이 그 모드로 열린다. 그 뒤에는 사용자가 바꾼 것이 남는다."""
    async def mode_of(sid: str) -> str:
        return (await client.get(f"/api/sessions/{sid}/state")).json()["mode"]

    plain = (await client.post("/api/sessions", json={"name": "보통", "preset_id": "basic"})).json()["id"]
    assert (await client.get("/api/presets/basic")).json()["start_mode"] == "" and await mode_of(plain) == "auto"

    r = await client.patch("/api/presets/basic", json={"start_mode": "autonomous"})
    assert r.status_code == 200 and r.json()["start_mode"] == "autonomous"
    solo = (await client.post("/api/sessions", json={"name": "혼자", "preset_id": "basic"})).json()["id"]
    assert await mode_of(solo) == "autonomous" and await mode_of(plain) == "auto"      # 이미 있던 작업은 그대로
    await client.put(f"/api/sessions/{solo}/state", json={"mode": "manual"})
    assert await mode_of(solo) == "manual"

    # 내보냈다 가져와도 남는다. 없는 모드는 받지 않는다
    packed = await client.get("/api/presets/basic/archive")
    got = (await client.post("/api/import", content=packed.content)).json()
    assert got["preset"]["start_mode"] == "autonomous"
    assert (await client.patch("/api/presets/basic", json={"start_mode": "빨리"})).status_code == 400


async def test_sessions_state_and_workspace(client):
    sid = await new_work(client, "등대")
    listed = (await client.get("/api/sessions")).json()["sessions"]
    assert [(s["name"], s["preset_id"], s["running"], s["chars"]) for s in listed] == [("등대", "basic", False, 0)]
    assert listed[0]["updated_at"] >= listed[0]["created_at"][:19]                    # 마지막으로 고친 때 (시작 자료가 깔린 때)
    meta = (await client.get("/api/meta")).json()
    assert (meta["version"], meta["version_date"]) == ("0.4.0", "2026-11-17")
    assert listed[0]["materials"] == len((await client.get(f"/api/sessions/{listed[0]['id']}/workspace")).json()["materials"]) > 0

    state = (await client.get(f"/api/sessions/{sid}/state")).json()
    assert state == {
        "preset_id": "basic", "mode": "auto", "bypass_locks": False, "auto_compact": True, "conversation": "main",
        "model": "test:agent", "effective_model": "test:agent",                             # 모델은 프리셋의 것이다
        "available": {"web_search": True, "web_fetch": True},      # 가짜 모델은 전부 된다고 한다
    }
    fake("test:other", ["끝."])
    state = (await client.put(f"/api/sessions/{sid}/state", json={"mode": "manual", "bypass_locks": True, "auto_compact": False})).json()
    assert (state["mode"], state["bypass_locks"], state["auto_compact"], state["preset_id"]) == ("manual", True, False, "basic")
    # 모델을 바꾸는 것은 프리셋을 고치는 것이다. 같은 프리셋을 쓰는 작업이 다 같이 바뀐다
    other = (await client.post("/api/sessions", json={"name": "다른 작업", "preset_id": "basic"})).json()["id"]
    await client.patch("/api/presets/basic", json={"model": "test:other"})
    for s in (sid, other):
        assert (await client.get(f"/api/sessions/{s}/state")).json()["effective_model"] == "test:other"
    await client.delete(f"/api/sessions/{other}")
    # 쓸 수 없는 모델(제공자가 없다)이 적혀 있으면 실제로 쓰일 모델은 비고, 골라야 한다
    await client.patch("/api/presets/basic", json={"model": "nowhere:x"})
    state = (await client.get(f"/api/sessions/{sid}/state")).json()
    assert (state["model"], state["effective_model"]) == ("nowhere:x", "")
    # 모델을 만들 수 없으면(키가 없는 제공자 등) 제공자 도구는 전부 못 쓰는 것으로 나온다
    await client.patch("/api/presets/basic", json={"model": "google:gemini-3-pro"})
    assert (await client.get(f"/api/sessions/{sid}/state")).json()["available"] == {"web_search": False, "web_fetch": False}
    await client.patch("/api/presets/basic", json={"model": "test:agent"})
    assert (await client.put(f"/api/sessions/{sid}/state", json={"preset_id": "없는것"})).status_code == 404
    assert (await client.put(f"/api/sessions/{sid}/state", json={"mode": "아무거나"})).status_code == 422

    ws = (await client.get(f"/api/sessions/{sid}/workspace")).json()
    assert set(ws) == {"state", "input", "output", "materials", "folders", "flags", "manuscript", "context"}
    assert ws["folders"] == []                                             # 시작 자료는 자료 바로 밑에 있다
    made = await client.post(f"/api/sessions/{sid}/docs/folders", json={"path": "자료/인물"})
    assert made.json() == {"path": "자료/인물"} and (await client.post(f"/api/sessions/{sid}/docs/folders", json={"path": "원고/x"})).status_code == 400
    assert (await client.get(f"/api/sessions/{sid}/workspace")).json()["folders"] == ["자료/인물"]   # 빈 폴더도 목록에 나온다
    moved = (await client.post(f"/api/sessions/{sid}/docs/move", json={"source": "자료/인물", "destination": "자료/사람들"})).json()
    assert moved == {"path": "자료/사람들", "moved": []}
    assert (await client.delete(f"/api/sessions/{sid}/docs/content", params={"path": "자료/사람들"})).status_code == 200
    assert (await client.get(f"/api/sessions/{sid}/workspace")).json()["folders"] == []
    assert ws["input"] == {"chars": 0, "updated_at": None, "by": "", "tool": ""}
    assert [(m["path"], m["kind"], m["note"], m["by"]) for m in ws["materials"]] == [
        ("자료/단기 계획.md", "text", True, "starter"), ("자료/작품 노트.md", "text", True, "starter"), ("자료/장기 계획.md", "text", True, "starter"),
    ]
    assert ws["flags"] == {"자료/작품 노트.md": {"note": True}, "자료/장기 계획.md": {"note": True}, "자료/단기 계획.md": {"note": True}}
    assert ws["manuscript"] == {"chars": 0, "locked": False, "chapters": []} and ws["context"] == {"conversation_id": "main", "tokens": 0, "budget": 150000}

    # 쓰던 프리셋을 지우면 작업은 남아 있는 프리셋으로 넘어간다. 목록과 상태가 같은 것을 가리킨다
    copy = (await client.post("/api/presets/basic/duplicate", json={"name": "잠깐 쓸 것"})).json()["id"]
    await client.put(f"/api/sessions/{sid}/state", json={"preset_id": copy})
    assert (await client.get("/api/sessions")).json()["sessions"][0]["preset_id"] == copy
    await client.delete(f"/api/presets/{copy}")
    assert (await client.get("/api/sessions")).json()["sessions"][0]["preset_id"] == "basic"
    assert (await client.get(f"/api/sessions/{sid}/state")).json()["preset_id"] == "basic"

    await client.patch(f"/api/sessions/{sid}", json={"name": "등대지기"})
    assert (await client.get("/api/sessions")).json()["sessions"][0]["name"] == "등대지기"
    assert (await client.delete(f"/api/sessions/{sid}")).status_code == 200
    assert (await client.get(f"/api/sessions/{sid}/workspace")).status_code == 404
    assert (await client.get("/api/sessions/not-a-uuid/workspace")).status_code == 404


# ------------------------------------------------------------------ 문서

async def test_documents(client):
    sid = await new_work(client)
    base = f"/api/sessions/{sid}"
    put = lambda path, content: client.put(f"{base}/docs/content", json={"path": path, "content": content})  # noqa: E731
    get = lambda path: client.get(f"{base}/docs/content", params={"path": path})  # noqa: E731

    assert (await put("자료/인물/서윤", "등대지기의 딸")).json() == {"path": "자료/인물/서윤", "created": True}
    assert (await put("입력", "서윤이 등대에 오른다. @include:자료/인물/서윤")).json()["path"] == "입력"
    assert (await get("자료/인물/서윤")).json() == {"path": "자료/인물/서윤", "content": "등대지기의 딸", "kind": "text", "locked": False, "note": False}
    assert (await get("출력")).json()["content"] == "" and (await get("자료/없음")).status_code == 404
    for path in ["../밖", "딴 곳/메모", "원고/없는 장면"]:
        assert (await put(path, "x")).status_code == 400

    # 수정 방지와 노트: 폴더에 걸면 안쪽에 적용되고, null이면 상속으로 되돌린다. 사람은 잠긴 문서도 고친다
    r = await client.put(f"{base}/flags", json={"path": "자료/인물", "locked": True})
    assert r.json()["flags"]["자료/인물"] == {"locked": True}
    await client.put(f"{base}/flags", json={"path": "자료/인물/서윤", "note": True, "locked": False})
    doc = (await get("자료/인물/서윤")).json()
    assert (doc["locked"], doc["note"]) == (False, True)
    flags = (await client.put(f"{base}/flags", json={"path": "자료/인물/서윤", "locked": None})).json()["flags"]
    assert flags["자료/인물/서윤.md"] == {"note": True} and (await get("자료/인물/서윤")).json()["locked"] is True
    assert (await put("자료/인물/서윤", "등대지기의 손녀")).status_code == 200
    assert (await client.put(f"{base}/flags", json={"path": "입력", "locked": True})).status_code == 400

    # 버전 기록, 복원, 옮기기, 지우기
    history = (await client.get(f"{base}/docs/history", params={"path": "자료/인물/서윤"})).json()["entries"]
    assert [(e["action"], e["by"], e["path"]) for e in history] == [("write", "user", "자료/인물/서윤")] * 2
    old = history[0]["hash"]
    assert (await client.get(f"{base}/docs/version", params={"hash": old})).json()["content"] == "등대지기의 딸"
    await client.post(f"{base}/docs/restore", json={"path": "자료/인물/서윤", "hash": old})
    assert (await get("자료/인물/서윤")).json()["content"] == "등대지기의 딸"
    moved = (await client.post(f"{base}/docs/move", json={"source": "자료/인물", "destination": "자료/사람들"})).json()
    assert moved == {"path": "자료/사람들", "moved": ["자료/사람들/서윤"]}
    assert (await get("자료/사람들/서윤")).json()["locked"] is True         # 설정이 폴더를 따라갔다
    assert (await client.delete(f"{base}/docs/content", params={"path": "자료/사람들"})).status_code == 200
    assert (await get("자료/사람들/서윤")).status_code == 404
    await client.delete(f"{base}/docs/content", params={"path": "입력"})   # 입력을 지우면 비워진다
    assert (await get("입력")).json()["content"] == ""

    # @include가 가리키는 것
    scene = (await client.post(f"{base}/manuscript/scenes", json={"content": "바람이 불었다."})).json()["id"]
    resolve = lambda ref: client.get(f"{base}/docs/resolve", params={"ref": ref})  # noqa: E731
    assert (await resolve("자료/단기 계획")).json() == {"kind": "doc", "path": "자료/단기 계획", "title": "자료/단기 계획"}
    assert (await resolve(f"원고/{scene}")).json() == {"kind": "scene", "path": f"원고/{scene}", "title": "1장 1번째 장면"}
    assert [(await resolve(r)).json()["kind"] for r in ["원고", "원고/1장", "자료", "자료/없음", "원고/9장"]] == [
        "manuscript", "chapter", "folder", "missing", "missing",
    ]


def docx_bytes(paragraphs: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    xml = f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("word/document.xml", xml)
    return buffer.getvalue()


def hwpx_bytes(paragraphs: list[str]) -> bytes:
    body = "".join(f"<hp:p><hp:run><hp:t>{p}</hp:t></hp:run></hp:p>" for p in paragraphs)
    xml = (
        '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
        f'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">{body}</hs:sec>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("Contents/section0.xml", xml)
    return buffer.getvalue()


async def test_upload_and_export(client):
    sid = await new_work(client, "등대지기의 딸")
    base = f"/api/sessions/{sid}"
    up = lambda name, data, **params: client.post(f"{base}/upload", params={"name": name, **params}, content=data)  # noqa: E731

    # 글 파일은 글을 뽑아 통짜 문서로 넣는다. 옛 메모장의 완성형 한글도 읽는다
    r = (await up("등대지기의 딸.txt", "배는 하루에 한 번 들어왔다.\r\n\r\n서윤은 기다렸다.".encode("cp949"))).json()
    assert r == {"path": "자료/올린 글/등대지기의 딸", "kind": "text", "chars": 27, "note": ""}
    assert (await up("등대지기의 딸.txt", "다른 글".encode("utf-8"))).json()["path"] == "자료/올린 글/등대지기의 딸 2"   # 같은 이름은 번호를 붙인다
    assert (await up("원고.docx", docx_bytes(["첫 문단.", "둘째 문단."]))).json()["chars"] == 13
    assert (await up("원고.hwpx", hwpx_bytes(["한글 첫 문단.", "한글 둘째 문단."]), folder="받은 것")).json()["path"] == "자료/받은 것/원고"
    doc = (await client.get(f"{base}/docs/content", params={"path": "자료/받은 것/원고"})).json()
    assert doc["content"] == "한글 첫 문단.\n\n한글 둘째 문단."
    history = (await client.get(f"{base}/docs/history", params={"path": "자료/올린 글/원고"})).json()["entries"]
    assert history[0]["origin"] == {"uploaded": "원고.docx"} and history[0]["by"] == "user"

    # 글을 못 뽑으면 그 자리에서 이유를 말하고 아무것도 넣지 않는다
    for name, data, message in [
        ("옛 문서.hwp", b"\xd0\xcf\x11\xe0", "옛 한글 형식"),
        ("깨진.docx", b"not a zip", "Word 문서를 열지 못했습니다"),
        ("빈 문서.txt", b"  \n ", "글을 뽑지 못했습니다"),
        ("악성.exe", b"MZ", "올릴 수 없습니다"),
        ("스캔.pdf", b"%PDF-1.4 broken", "PDF를 열지 못했습니다. 파일이 손상됐거나"),
    ]:
        r = await up(name, data)
        assert r.status_code == 422 and message in r.json()["error"], (name, r.text)
        assert "Error" not in r.json()["error"]                           # 예외 이름 같은 것은 보이지 않는다
    assert (await up("빈.txt", b"")).status_code == 400

    # 스캔한 PDF: 글은 못 뽑지만 파일은 멀쩡하다. 파일 그대로 넣어 두고, 에이전트가 직접 보게 한다
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    scanned = io.BytesIO()
    writer.write(scanned)
    r = (await up("스캔본.pdf", scanned.getvalue())).json()
    assert (r["path"], r["kind"], r["chars"]) == ("자료/올린 글/스캔본.pdf", "file", 0) and "에이전트가 읽을 수 있습니다" in r["note"]
    got = await client.get(f"{base}/files", params={"path": "자료/올린 글/스캔본.pdf"})
    assert got.content == scanned.getvalue() and got.headers["content-type"] == "application/pdf"

    # 이미지는 그대로 자료에 들어가고, 파일로 다시 받을 수 있다
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    image = (await up("등대.png", png)).json()
    assert image == {"path": "자료/삽화/등대.png", "kind": "image", "chars": 0, "note": ""}
    got = await client.get(f"{base}/files", params={"path": "자료/삽화/등대.png"})
    assert got.content == png and got.headers["content-type"] == "image/png"
    assert (await client.get(f"{base}/files", params={"path": "자료/삽화/없음.png"})).status_code == 404
    spaced = (await up("등대 그림.png", png)).json()["path"]
    assert spaced == "자료/삽화/등대 그림.png"
    for written in ["자료/삽화/등대 그림.png", "자료/삽화/등대%20그림.png"]:   # 원고에 %20으로 적어도 찾는다
        assert (await client.get(f"{base}/files", params={"path": written})).content == png
    kinds = {m["path"]: m["kind"] for m in (await client.get(f"{base}/workspace")).json()["materials"]}
    assert kinds["자료/삽화/등대.png"] == "image" and kinds["자료/올린 글/원고.md"] == "text"

    # 내보내기: 장 번호, 장면 순서, 이미지
    await client.post(f"{base}/manuscript/scenes", json={"content": "바람이 불었다.\n\n![등대](자료/삽화/등대.png)"})
    await client.post(f"{base}/manuscript/scenes", json={"content": "아침이 왔다.\n\n![](자료/삽화/등대 그림.png)", "new_chapter": True})
    md = await client.get(f"{base}/export", params={"format": "md"})
    assert md.text == (
        "# 등대지기의 딸\n\n## 1장\n\n바람이 불었다.\n\n![등대](자료/삽화/등대.png)\n\n"
        "## 2장\n\n아침이 왔다.\n\n![](자료/삽화/등대 그림.png)\n"
    )
    assert "filename*=UTF-8''" in md.headers["content-disposition"] and ".md" in md.headers["content-disposition"]
    plain = await client.get(f"{base}/export", params={"format": "md", "chapters": "false"})   # 장 번호를 빼고
    assert plain.text == "# 등대지기의 딸\n\n바람이 불었다.\n\n![등대](자료/삽화/등대.png)\n\n아침이 왔다.\n\n![](자료/삽화/등대 그림.png)\n"
    txt = (await client.get(f"{base}/export", params={"format": "txt"})).content.decode("utf-8-sig")
    assert "[그림: 등대]" in txt and "[그림: 등대 그림.png]" in txt and "#" not in txt and "![" not in txt
    page = (await client.get(f"{base}/export", params={"format": "html"})).text
    assert page.count('<img src="data:image/png;base64,') == 2 and "<h2>2장</h2>" in page and "<p>아침이 왔다.</p>" in page
    with zipfile.ZipFile(io.BytesIO((await client.get(f"{base}/export", params={"format": "zip"})).content)) as z:
        assert sorted(z.namelist()) == ["등대지기의 딸.md", "자료/삽화/등대 그림.png", "자료/삽화/등대.png"]
        assert z.read("자료/삽화/등대 그림.png") == png
    assert (await client.get(f"{base}/export", params={"format": "docx"})).status_code == 400


# ------------------------------------------------------------------ 원고

async def test_manuscript(client):
    sid = await new_work(client)
    base = f"/api/sessions/{sid}"
    scenes = f"{base}/manuscript/scenes"
    ids = lambda ws: [[s["id"] for s in c["scenes"]] for c in ws["manuscript"]["chapters"]]  # noqa: E731
    workspace = lambda: client.get(f"{base}/workspace")  # noqa: E731

    a = (await client.post(scenes, json={"content": "가."})).json()
    assert a == {"id": "s1", "path": "원고/s1", "chapter": "c1"}
    b = (await client.post(scenes, json={"content": "나."})).json()["id"]
    c = (await client.post(scenes, json={"content": "다.", "after": "s1"})).json()["id"]      # s1 뒤
    d = (await client.post(scenes, json={"content": "라.", "after": None})).json()["id"]       # 맨 앞
    e = (await client.post(scenes, json={"content": "마.", "new_chapter": True})).json()["id"]
    assert ids((await workspace()).json()) == [[d, "s1", c, b], [e]]

    # 출력에서 가져와 넣으면 출력이 비워진다
    await client.put(f"{base}/docs/content", json={"path": "출력", "content": "도구가 쓴 글."})
    f = (await client.post(scenes, json={"from_output": True, "chapter": "c2"})).json()["id"]
    ws = (await workspace()).json()
    assert ids(ws) == [[d, "s1", c, b], [e, f]] and ws["output"]["chars"] == 0
    # 화면의 '+ 장면': 빈 장면을 만들고 거기에 직접 쓴다. 출력이 비어 있는데 출력에서 가져오라는 것은 받지 않는다
    blank = (await client.post(scenes, json={"chapter": "c1"})).json()["id"]
    assert (await client.get(f"{base}/docs/content", params={"path": f"원고/{blank}"})).json()["content"] == ""
    assert (await client.post(scenes, json={"from_output": True})).status_code == 400
    assert (await client.delete(f"{scenes}/{blank}")).status_code == 200

    # 옮기기, 요약
    await client.post(f"{scenes}/{b}/move", json={"chapter": "c2", "after": None})
    await client.patch(f"{scenes}/{c}", json={"summary": "내가 쓴 요약"})
    ws = (await workspace()).json()
    scene_c = next(s for ch in ws["manuscript"]["chapters"] for s in ch["scenes"] if s["id"] == c)
    assert ids(ws) == [[d, "s1", c], [b, e, f]] and (scene_c["summary"], scene_c["summary_state"]) == ("내가 쓴 요약", "manual")
    assert (scene_c["number"], scene_c["path"], scene_c["chars"], scene_c["by"], scene_c["head"]) == (3, f"원고/{c}", 2, "user", "다.")
    await client.patch(f"{scenes}/{c}", json={"summary": None})          # 직접 쓴 요약을 지운다

    # 엔진이 알아서 요약하지 않는다. 요약의 상태만 알려 준다
    m = client.app.state.ctx.docs(sid).manuscript
    m.set_summary("s1", "에이전트가 붙인 요약", content_hash(m.content("s1")))
    states = lambda: {s["id"]: s["summary_state"] for ch in m.overview()["chapters"] for s in ch["scenes"]}  # noqa: E731
    assert (states()["s1"], states()[c], states()[d]) == ("ok", "none", "none")
    await client.put(f"{base}/docs/content", json={"path": "원고/s1", "content": "가. 그리고 더."})
    ws = (await workspace()).json()
    assert next(s for ch in ws["manuscript"]["chapters"] for s in ch["scenes"] if s["id"] == "s1")["summary_state"] == "stale"

    # 나누기(글자 위치)와 합치기
    await client.put(f"{base}/docs/content", json={"path": f"원고/{d}", "content": "앞 문단.\n\n뒤 문단."})
    parts = (await client.post(f"{scenes}/{d}/split", json={"at": [7]})).json()["ids"]
    assert parts[0] == d and (await client.get(f"{base}/docs/content", params={"path": f"원고/{parts[1]}"})).json()["content"] == "뒤 문단."
    assert (await client.post(f"{base}/manuscript/merge", json={"scenes": parts})).json() == {"id": d}
    assert (await client.get(f"{base}/docs/content", params={"path": f"원고/{d}"})).json()["content"] == "앞 문단.\n\n뒤 문단."
    assert (await client.post(f"{scenes}/{d}/split", json={"at": []})).status_code == 400

    # 장: 만들기, 순서, 수정 방지, 지우기
    chapter = (await client.post(f"{base}/manuscript/chapters", json={"after": "c1"})).json()["id"]
    await client.post(f"{base}/manuscript/chapters/{chapter}/move", json={"after": "c2"})
    await client.put(f"{base}/flags", json={"path": "원고/c1", "locked": True})
    ws = (await workspace()).json()
    assert [(ch["id"], ch["number"], ch["locked"]) for ch in ws["manuscript"]["chapters"]] == [
        ("c1", 1, True), ("c2", 2, False), (chapter, 3, False),
    ]
    assert ws["manuscript"]["chapters"][0]["scenes"][0]["locked"] is True and ws["manuscript"]["chars"] > 0
    assert (await client.delete(f"{base}/manuscript/chapters/c1")).status_code == 409
    assert (await client.delete(f"{base}/manuscript/chapters/{chapter}")).status_code == 200

    # 지운 것의 목록에서 골라 복원한다. 지운 장면은 원고 끝에 새 장면으로 돌아온다. 무엇인지는 글의 첫 줄로 알아본다
    assert (await client.delete(f"{scenes}/{e}")).status_code == 200
    gone = (await client.get(f"{base}/deleted")).json()["items"]
    item = next(d for d in gone if d["path"] == f"원고/{e}")
    assert (item["kind"], item["by"], item["head"], item["chars"]) == ("scene", "user", "마.", 2)
    assert all(d["path"] != f"원고/{blank}" for d in gone)                # 빈 채로 지운 장면은 되살릴 것이 없다
    restored = (await client.post(f"{base}/docs/restore", json={"path": item["path"], "hash": item["hash"]})).json()["path"]
    assert restored != f"원고/{e}" and (await client.get(f"{base}/docs/content", params={"path": restored})).json()["content"] == "마."
    last = (await workspace()).json()["manuscript"]["chapters"][-1]["scenes"][-1]
    assert last["path"] == restored
    assert all(d["path"] != f"원고/{e}" for d in (await client.get(f"{base}/deleted")).json()["items"])   # 복원한 것은 목록에서 빠진다
    assert (await client.delete(f"{scenes}/s999")).status_code == 400


# ------------------------------------------------------------------ 실행

async def test_runs_over_http(client):
    sid = await new_work(client)
    base = f"/api/sessions/{sid}"
    fake("test:agent", scripted([
        call("write", path="입력", content="서윤이 등대에 오른다."),
        call("compose"),
        call("insert_scene", from_output=True),
        call("set_summary", target="원고/s1", summary="요약이다."),
        "원고에 올렸다.",
    ]))

    # 프리셋에 모델이 없으면 시작 전에 읽을 수 있는 말로 막는다
    await client.patch("/api/presets/basic", json={"model": ""})
    r = await client.post(f"{base}/runs", json={"goal": "써줘"})
    assert r.status_code == 400 and "채팅창에서 모델을 골라야" in r.json()["error"]
    await client.patch("/api/presets/basic", json={"model": "test:agent"})
    assert (await client.post(f"{base}/runs", json={"goal": "  "})).status_code == 400
    assert (await client.post(f"{base}/runs", json={"goal": "써줘", "tool": "없는 도구"})).status_code == 404

    # 자동 모드: 원고에 넣기 전에 확인을 받는다. 답은 respond로 준다
    r = await client.post(f"{base}/runs", json={"goal": "첫 장면을 써줘"})
    assert r.status_code == 200, r.text
    assert (await client.post(f"{base}/runs", json={"goal": "또"})).status_code == 409
    # (테스트용 클라이언트는 스트림을 끝난 뒤에야 돌려주므로, 기다리는 동안은 기록을 들여다보고 답한다)
    for _ in range(200):
        saved = (await client.get(f"{base}/events")).json()
        if saved["run"]["waiting_for_user"]:
            break
        await asyncio.sleep(0.02)
    pending = next(e for e in saved["events"] if e["type"] == "user_input_required")
    assert (await client.post(f"{base}/respond", json={"event_id": pending["event_id"], "response": "승인"})).status_code == 200
    events = sse_events((await client.get(f"{base}/stream")).text)
    assert events[-1]["type"] == "done" and events[-1]["status"] == "completed"
    assert [e["tool"] for e in events if e["type"] == "tool_call"] == ["write", "compose", "insert_scene", "set_summary"]
    ask = next(e for e in events if e["type"] == "user_input_required")
    assert (ask["kind"], ask["action"], ask["new"]) == ("proposal", "insert", "바람이 불었다.")
    assert (await client.post(f"{base}/respond", json={"event_id": ask["event_id"], "response": "승인"})).status_code == 409

    ws = (await client.get(f"{base}/workspace")).json()
    scene = ws["manuscript"]["chapters"][0]["scenes"][0]
    assert (scene["summary"], scene["chars"]) == ("요약이다.", 8) and ws["context"]["tokens"] > 0
    saved = (await client.get(f"{base}/events")).json()
    assert saved["run"]["running"] is False and saved["events"][-1]["type"] == "done"
    assert [e["type"] for e in saved["events"]].count("user_input_resolved") == 1

    # 도구 실행 기록: 이전 입력과 출력을 다시 본다. 버전 기록은 그 실행을 가리킨다
    runs = (await client.get(f"{base}/tool-runs")).json()["runs"]
    assert [(r["seq"], r["tool"], r["label"], r["by"], r["input"], r["output"]) for r in runs] == [
        (1, "compose", "집필", "agent", "서윤이 등대에 오른다.", "바람이 불었다."),
    ]

    # 사용자가 도구를 직접 돌린다
    assert (await client.post(f"{base}/tools/없는도구/run")).status_code == 404
    # 지시문이 아직 빈 도구는 돌릴 수 없다
    preset = (await client.get("/api/presets/basic")).json()
    preset["tools"].append({"name": "tool_draft", "label": "쓰다 만 도구", "prompt": ""})
    await client.put("/api/presets/basic", json=preset)
    r = await client.post(f"{base}/tools/tool_draft/run")
    assert r.status_code == 400 and "지시문이 비어" in r.json()["error"]
    r = await client.post(f"{base}/tools/집필/run")                        # 보이는 이름으로도 부를 수 있다
    assert r.status_code == 200
    direct = sse_events((await client.get(f"{base}/stream")).text)
    assert direct[0]["kind"] == "tool" and direct[-1]["status"] == "completed"
    assert (await client.get(f"{base}/docs/content", params={"path": "출력"})).json()["content"] == "바람이 불었다."
    history = (await client.get(f"{base}/docs/history", params={"path": "출력"})).json()["entries"]
    assert history[-1]["tool_run"] == {"tool": "compose", "label": "집필", "model": "test:writer", "duration_ms": history[-1]["tool_run"]["duration_ms"], "run_seq": 2}
    await client.delete(f"{base}/docs/content", params={"path": "입력"})
    r = await client.post(f"{base}/tools/compose/run")
    assert r.status_code == 400 and "입력이 비어" in r.json()["error"]

    log = (await client.get(f"{base}/process-log")).json()["content"]
    assert "프리셋: 기본" in log and "모드: 자동" in log and "사용자가 도구를 직접 돌림: 집필" in log and "실행 종료 (완료)" in log


async def test_work_export_and_import(client):
    sid = await new_work(client, "등대지기의 딸")
    base = f"/api/sessions/{sid}"
    # 프리셋을 복제해 쓰는 작업: 받는 쪽에 그 프리셋이 없을 수 있다
    mine = (await client.post("/api/presets/basic/duplicate", json={"name": "내 방식"})).json()["id"]
    await client.put(f"{base}/state", json={"preset_id": mine, "mode": "autonomous"})
    await client.put(f"{base}/docs/content", json={"path": "자료/인물/서윤", "content": "등대지기의 딸"})
    await client.put(f"{base}/flags", json={"path": "자료/인물", "locked": True})
    fake("test:agent", scripted([
        call("write", path="입력", content="지시서"), call("compose"), call("insert_scene", from_output=True),
        call("summarize_scenes"), "썼다.",
    ]))
    await client.post(f"{base}/runs", json={"goal": "첫 장면을 써줘"})
    await client.get(f"{base}/stream")

    packed = await client.get(f"{base}/archive")
    assert packed.status_code == 200 and packed.headers["content-type"] == "application/octet-stream"
    assert unquote(packed.headers["content-disposition"]).endswith("등대지기의 딸.aleph")
    with zipfile.ZipFile(io.BytesIO(packed.content)) as z:       # 속은 zip이다
        names = set(z.namelist())
        assert {
            "aleph.json", "preset/preset.yaml", "preset/instruction.md", "preset/tools/compose.md",
            "session/meta.json", "session/manuscript.json", "session/events.jsonl", "session/docs/원고/s1.md",
        } <= names
        manifest = json.loads(z.read("aleph.json"))
        assert (manifest["kind"], manifest["format"], manifest["preset_id"]) == ("work", 1, mine)

    # 프리셋이 없는 컴퓨터로 옮긴 것처럼: 프리셋을 지우고 들여온다
    await client.delete(f"/api/presets/{mine}")
    got = (await client.post("/api/import", content=packed.content)).json()
    assert got["kind"] == "work"
    assert got["id"] != sid and got["name"] == "등대지기의 딸 (가져옴)" and got["preset_id"] == mine   # 같은 이름이 있어 표시가 붙고, 프리셋도 같이 들어왔다
    assert (await client.get(f"/api/presets/{mine}")).json()["name"] == "내 방식"
    new = f"/api/sessions/{got['id']}"
    ws = (await client.get(f"{new}/workspace")).json()
    scene = ws["manuscript"]["chapters"][0]["scenes"][0]
    assert (scene["summary"], scene["chars"]) == ("요약이다.", 8)
    assert ws["flags"]["자료/인물"] == {"locked": True} and ws["state"]["mode"] == "autonomous"
    assert (await client.get(f"{new}/docs/content", params={"path": "자료/인물/서윤"})).json()["content"] == "등대지기의 딸"
    assert [e["type"] for e in (await client.get(f"{new}/events")).json()["events"]][-1] == "done"       # 대화도 그대로
    runs = (await client.get(f"{new}/tool-runs")).json()["runs"]
    assert [(r["tool"], r["target"]) for r in runs] == [("compose", None), ("summarize", "원고/s1")]   # 묶음 요약은 어느 장면의 것인지 남는다
    history = (await client.get(f"{new}/docs/history", params={"path": "원고/s1"})).json()["entries"]
    assert history and history[0]["by"] == "agent"                         # 버전 기록도
    assert len((await client.get("/api/sessions")).json()["sessions"]) == 2

    # 같은 프리셋이 이미 있으면 있는 것을 쓴다. ALEPH 작업이 아닌 파일은 거절한다
    again = (await client.post("/api/import", content=packed.content)).json()
    assert again["name"] == "등대지기의 딸 (가져옴) 2" and again["preset_id"] == mine and len((await client.get("/api/presets")).json()["presets"]) == SHIPPED + 1
    for bad, message in [(b"not a zip", "내보낸 파일이 아닙니다"), (b"", "빈 파일")]:
        r = await client.post("/api/import", content=bad)
        assert r.status_code == 400 and message in r.json()["error"]
    other = io.BytesIO()
    with zipfile.ZipFile(other, "w") as z:
        z.writestr("hello.txt", "x")
    r = await client.post("/api/import", content=other.getvalue())
    assert r.status_code == 400 and "내보낸 파일이 아닙니다" in r.json()["error"]
    newer = io.BytesIO()                                         # 형식 번호가 다른 파일은 읽지 않는다
    with zipfile.ZipFile(newer, "w") as z:
        z.writestr("aleph.json", json.dumps({"app": "ALEPH", "kind": "work", "format": 99, "name": "다른 버전", "preset_id": "basic"}))
        z.writestr("session/meta.json", json.dumps({"name": "다른 버전"}))
    r = await client.post("/api/import", content=newer.getvalue())
    assert r.status_code == 400 and "읽을 수 없는 파일" in r.json()["error"]
    # 폴더 밖으로 나가려는 경로가 든 파일: 그 항목만 버리고 나머지를 들여온다
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("aleph.json", json.dumps({"app": "ALEPH", "kind": "work", "format": 1, "name": "수상한 작업", "preset_id": "basic"}))
        z.writestr("session/meta.json", json.dumps({"name": "수상한 작업"}))
        z.writestr("session/../../밖.txt", "x")
        z.writestr("session/docs/자료/메모.md", "안쪽")
    got = (await client.post("/api/import", content=evil.getvalue())).json()
    assert (await client.get(f"/api/sessions/{got['id']}/docs/content", params={"path": "자료/메모"})).json()["content"] == "안쪽"
    data_dir = client.app.state.ctx.paths.data
    assert not list(data_dir.rglob("밖.txt")) and not (data_dir.parent / "밖.txt").exists()


async def test_trial_runs_compare_the_same_input(client):
    sid = await new_work(client, mode="autonomous")
    base = f"/api/sessions/{sid}"
    fake("test:agent", scripted([call("write", path="입력", content="서윤이 등대에 오른다."), call("compose"), "썼다."]))
    await client.post(f"{base}/runs", json={"goal": "써줘"})
    await client.get(f"{base}/stream")
    last = (await client.get(f"{base}/runs/last")).json()["run_id"]
    output = lambda: client.get(f"{base}/docs/content", params={"path": "출력"})  # noqa: E731
    assert (await output()).json()["content"] == "바람이 불었다."

    # 같은 입력을 다른 모델로 다시 돌린다. 출력은 그대로고, 결과는 기록에만 남는다
    fake("test:other", ["파도가 방파제를 넘었다."])
    await client.put(f"{base}/docs/content", json={"path": "입력", "content": "그 사이에 고친 입력"})
    r = await client.post(f"{base}/tools/compose/run", json={"trial": True, "input_seq": 1, "model": "test:other"})
    assert r.status_code == 200
    events = sse_events((await client.get(f"{base}/stream")).text)
    assert (events[0]["kind"], events[0]["trial"]) == ("tool", True)
    result = next(e for e in events if e["type"] == "tool_result")
    assert (result["trial"], result["result"], result["changed"]) == (True, "파도가 방파제를 넘었다.", [])
    assert (await output()).json()["content"] == "바람이 불었다."
    runs = (await client.get(f"{base}/tool-runs")).json()["runs"]
    assert [(r["seq"], r["trial"], r["base_seq"], r["model"], r["input"], r["output"]) for r in runs] == [
        (1, False, None, "test:writer", "서윤이 등대에 오른다.", "바람이 불었다."),
        (2, True, 1, "test:other", "서윤이 등대에 오른다.", "파도가 방파제를 넘었다."),
    ]
    assert (await client.get(f"{base}/runs/last")).json()["run_id"] == last   # 시험 실행은 되돌릴 대상이 아니다

    # 다른 도구로도 같은 입력을 돌려 본다. 입력 번호를 안 주면 지금의 입력을 쓴다
    await client.post(f"{base}/tools/critique/run", json={"trial": True, "input_seq": 2})
    await client.get(f"{base}/stream")
    await client.post(f"{base}/tools/compose/run", json={"trial": True})
    await client.get(f"{base}/stream")
    runs = (await client.get(f"{base}/tool-runs")).json()["runs"]
    assert [(r["tool"], r["base_seq"], r["input"]) for r in runs[2:]] == [
        ("critique", 1, "서윤이 등대에 오른다."), ("compose", None, "그 사이에 고친 입력"),
    ]
    assert (await client.post(f"{base}/tools/compose/run", json={"trial": True, "input_seq": 99})).status_code == 404
    r = await client.post(f"{base}/tools/compose/run", json={"trial": True, "model": "nowhere:x"})
    assert r.status_code == 400 and "쓸 수 없습니다" in r.json()["error"]


async def test_search_and_usage(client):
    sid = await new_work(client)
    base = f"/api/sessions/{sid}"
    await client.put(f"{base}/docs/content", json={"path": "자료/인물/서윤", "content": "등대지기의 딸.\n서윤은 말수가 적다. 서윤은 손이 빠르다."})
    await client.post(f"{base}/manuscript/scenes", json={"content": "바람이 불었다.\n\n서윤은 난간을 붙잡았다."})

    found = (await client.get(f"{base}/search", params={"q": "서윤"})).json()
    assert found["truncated"] is False and [(h["path"], h["line"], h["start"]) for h in found["hits"]] == [
        ("원고/s1", 3, 0), ("자료/인물/서윤", 2, 0), ("자료/인물/서윤", 2, 12),
    ]
    assert found["hits"][1]["title"] == "인물/서윤" and found["hits"][1]["zone"] == "material"
    assert found["hits"][0] == {
        "path": "원고/s1", "title": "1장 1번째 장면", "zone": "manuscript", "line": 3, "start": 0, "text": "서윤은 난간을 붙잡았다.",
    }
    only = (await client.get(f"{base}/search", params={"q": "서윤", "scope": "materials"})).json()["hits"]
    assert {h["zone"] for h in only} == {"material"} and len(only) == 2
    assert (await client.get(f"{base}/search", params={"q": "  "})).json() == {"hits": [], "truncated": False}
    assert (await client.get(f"{base}/search", params={"q": "x", "scope": "아무데나"})).status_code == 400

    empty = (await client.get(f"{base}/usage")).json()
    assert empty == {
        "runs": 0, "agent": {"prompt_tokens": 0, "output_tokens": 0, "cost_usd": None}, "tools": [],
        "auxiliary": {"calls": 0, "total_tokens": 0, "cost_usd": None}, "total_cost_usd": None, "cost_complete": True,
    }
    fake("test:agent", scripted([call("write", path="입력", content="지시서"), call("compose"), "끝."]))
    await client.put(f"{base}/state", json={"mode": "autonomous"})
    await client.post(f"{base}/runs", json={"goal": "써줘"})
    await client.get(f"{base}/stream")
    used = (await client.get(f"{base}/usage")).json()
    assert used["runs"] == 1 and used["agent"]["prompt_tokens"] > 0 and used["agent"]["output_tokens"] > 0
    assert [(t["tool"], t["label"], t["calls"]) for t in used["tools"]] == [("compose", "집필", 1)] and used["tools"][0]["total_tokens"] > 0
    assert used["auxiliary"]["calls"] == 0                                # 엔진이 알아서 부르는 요약은 없다
    assert used["total_cost_usd"] is None and used["cost_complete"] is False   # 가짜 모델은 단가가 없다


async def test_conversation_can_be_compacted_by_hand(client):
    """채팅창의 `지금 압축`. 한도를 넘지 않았어도 대화의 앞부분을 요약으로 바꾼다."""
    sid = await new_work(client, mode="autonomous")
    base = f"/api/sessions/{sid}"
    assert (await client.post(f"{base}/conversation/compact")).json() == {"compacted": False}   # 줄일 대화가 없다

    fake("test:agent", scripted([
        call("write", path="자료/메모", content="가 " * 400), call("read", path="자료/메모"), call("list"),
        call("read", path="자료/메모"), "다 읽었다.",
    ]))
    await client.post(f"{base}/runs", json={"goal": "메모를 쓰고 읽어줘"})
    await client.get(f"{base}/stream")
    before = (await client.get(f"{base}/workspace")).json()["context"]["tokens"]

    # 요약을 기다리는 동안에는 이 작업에서 실행을 시작하지 못한다 (시작되면 그 실행의 기억이 압축 결과에 덮인다)
    manager = client.app.state.ctx.runs
    with manager.hold(sid):
        assert (await client.post(f"{base}/runs", json={"goal": "압축 중에 보낸 말"})).status_code == 409
        assert (await client.post(f"{base}/conversation/compact")).status_code == 409
    done = (await client.post(f"{base}/conversation/compact")).json()
    assert (done["compacted"], done["kind"], done["summary"]) == (True, "summary", "요약이다.")
    assert done["tokens_after"] < done["tokens_before"] and done["dropped_messages"] > 0
    ws = (await client.get(f"{base}/workspace")).json()
    assert ws["context"]["tokens"] == done["tokens_after"] < before
    last = (await client.get(f"{base}/events")).json()["events"][-1]
    assert (last["type"], last["manual"], last["summary"]) == ("compaction", True, "요약이다.")   # 대화 기록에도 남는다

    # 줄인 뒤에도 대화는 이어진다. 에이전트는 요약과 사용자가 했던 말을 받는다
    seen: list[str] = []

    def script(messages):
        seen.extend(str(p.content) for m in messages for p in getattr(m, "parts", []) if type(p).__name__ == "UserPromptPart")
        return "알겠다."

    fake("test:agent", script)
    await client.post(f"{base}/runs", json={"goal": "이어서 해줘"})
    events = sse_events((await client.get(f"{base}/stream")).text)
    assert events[-1]["status"] == "completed"
    assert "<previous_work_summary>" in seen[0] and "<user_message>\n메모를 쓰고 읽어줘\n</user_message>" in seen[0]


async def test_one_work_can_hold_several_conversations(client):
    """대화마다 기록과 기억이 따로다. 문서와 원고는 같이 쓴다. 한 작업에서는 한 번에 하나만 돈다."""
    sid = await new_work(client, mode="autonomous")
    base = f"/api/sessions/{sid}"
    listed = (await client.get(f"{base}/conversations")).json()
    assert [(c["id"], c["name"], c["running"], c["context_tokens"]) for c in listed["conversations"]] == [("main", "", False, 0)]
    assert listed["current"] == "main"

    seen: list[list[str]] = []

    def script(messages):
        seen.append([str(p.content) for m in messages for p in getattr(m, "parts", []) if type(p).__name__ == "UserPromptPart"])
        return call("write", path="자료/메모", content="첫 대화에서 쓴 메모") if len(seen) == 1 else "알겠다."

    fake("test:agent", script)
    first = (await client.post(f"{base}/runs", json={"goal": "메모를 써줘\n자세히"})).json()
    assert first["conversation_id"] == "main"
    events = sse_events((await client.get(f"{base}/stream")).text)
    assert events[-1]["status"] == "completed" and {e["conversation_id"] for e in events} == {"main"}

    # 새 대화: 앞 대화의 기억은 없고, 문서는 그대로 보인다
    second = (await client.post(f"{base}/conversations", json={})).json()
    cid = second["id"]
    assert cid != "main" and second["name"] == "" and (await client.get(f"{base}/state")).json()["conversation"] == cid
    assert (await client.get(f"{base}/events")).json() == {
        "conversation_id": cid, "events": [], "run": (await client.get(f"{base}/events")).json()["run"],
    }
    assert (await client.get(f"{base}/workspace")).json()["context"] == {"conversation_id": cid, "tokens": 0, "budget": 150000}
    seen.clear()
    seen.append([])                                                       # 다음 호출부터는 "알겠다."
    await client.post(f"{base}/runs", json={"goal": "이어서 뭘 할까?"})     # 대화를 안 적으면 보고 있는 대화로 간다
    events = sse_events((await client.get(f"{base}/stream")).text)
    assert {e["conversation_id"] for e in events} == {cid}
    assert seen[1] == ["이어서 뭘 할까?"]                                   # 첫 대화에서 한 말은 들어 있지 않다
    assert (await client.get(f"{base}/docs/content", params={"path": "자료/메모"})).json()["content"] == "첫 대화에서 쓴 메모"

    # 대화를 적어 보내면 그 대화에서 이어진다. 이름은 첫 요청의 첫 줄이다
    await client.post(f"{base}/runs", json={"goal": "메모를 다시 봐줘", "conversation": "main"})
    await client.get(f"{base}/stream")
    assert seen[2] == ["메모를 써줘\n자세히", "메모를 다시 봐줘"]
    listed = (await client.get(f"{base}/conversations")).json()
    assert [(c["id"], c["name"]) for c in listed["conversations"]] == [("main", "메모를 써줘"), (cid, "이어서 뭘 할까?")]
    assert listed["current"] == "main" and all(c["context_tokens"] > 0 for c in listed["conversations"])
    types = lambda c: [e["type"] for e in c]  # noqa: E731
    main_events = (await client.get(f"{base}/events", params={"conversation": "main"})).json()["events"]
    other_events = (await client.get(f"{base}/events", params={"conversation": cid})).json()["events"]
    assert types(main_events).count("run_started") == 2 and types(other_events).count("run_started") == 1
    assert (await client.get(f"{base}/workspace", params={"conversation": cid})).json()["context"]["conversation_id"] == cid

    # 비용과 제작 기록은 대화를 다 합친 것이다. 되돌리기는 작업에서 마지막으로 돈 실행이고, 어느 대화의 것인지 알려 준다
    assert (await client.get(f"{base}/usage")).json()["runs"] == 3
    assert (await client.get(f"{base}/process-log")).json()["content"].count("이어서 뭘 할까?") >= 1
    assert (await client.get(f"{base}/runs/last")).json()["conversation_id"] == "main"

    # 이름 바꾸기, 없는 대화, 지우기
    renamed = (await client.patch(f"{base}/conversations/{cid}", json={"name": "곁가지"})).json()
    assert (renamed["id"], renamed["name"]) == (cid, "곁가지")
    for r in (
        await client.get(f"{base}/events", params={"conversation": "nope"}),
        await client.post(f"{base}/runs", json={"goal": "x", "conversation": "nope"}),
        await client.put(f"{base}/state", json={"conversation": "nope"}),
        await client.delete(f"{base}/conversations/BAD_ID"),
    ):
        assert r.status_code == 404, r.text
    # 마지막으로 돈 실행이 `main`의 것이다. 그 대화를 지운 뒤에 되돌려도 지운 기억이 되살아나지 않는다
    last_run_id = (await client.get(f"{base}/runs/last")).json()["run_id"]
    left = (await client.delete(f"{base}/conversations/main")).json()
    assert [c["id"] for c in left["conversations"]] == [cid] and left["current"] == cid
    folder = client.app.state.ctx.sessions.path(sid)
    assert not (folder / "events.jsonl").exists() and not (folder / "history.json").exists()
    assert (await client.get(f"{base}/docs/content", params={"path": "자료/메모"})).json()["content"] == "첫 대화에서 쓴 메모"   # 문서는 그대로다
    last = (await client.delete(f"{base}/conversations/{cid}")).json()     # 마지막 대화를 지우면 빈 대화 하나가 남는다
    assert [(c["id"], c["name"], c["context_tokens"]) for c in last["conversations"]] == [("main", "", 0)] and last["current"] == "main"
    await client.post(f"{base}/runs/{last_run_id}/revert", json={"force": True})
    assert not (folder / "history.json").exists() and (await client.get(f"{base}/events")).json()["events"] == []
    assert (await client.get(f"{base}/conversations")).json()["conversations"][0]["context_tokens"] == 0
    assert not (folder / "conversations" / cid).exists()

    # 내보냈다 가져와도 대화들이 그대로 따라온다
    extra = (await client.post(f"{base}/conversations", json={"name": "둘째"})).json()["id"]
    await client.post(f"{base}/runs", json={"goal": "둘째 대화의 말"})
    await client.get(f"{base}/stream")
    packed = await client.get(f"{base}/archive")
    got = (await client.post("/api/import", content=packed.content)).json()
    copied = (await client.get(f"/api/sessions/{got['id']}/conversations")).json()["conversations"]
    assert [(c["id"], c["name"]) for c in copied] == [("main", ""), (extra, "둘째")]
    events = (await client.get(f"/api/sessions/{got['id']}/events", params={"conversation": extra})).json()["events"]
    assert [e["text"] for e in events if e["type"] == "user_message"] == ["둘째 대화의 말"]


async def test_unready_provider_blocks_run(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    await client.patch("/api/presets/basic", json={"model": "google:gemini-x"})
    sid = (await client.post("/api/sessions", json={"name": "키 없음", "preset_id": "basic"})).json()["id"]
    r = await client.post(f"/api/sessions/{sid}/runs", json={"goal": "써줘"})
    assert r.status_code == 400 and "API 키" in r.json()["error"]


# ------------------------------------------------------------------ 폰트와 화면 설정

def make_font(family: str, style: str = "Regular", weight: int = 400, *, korean: str = "", italic: bool = False,
              typographic: tuple[str, str] | None = None, variable: bool = False, flavor: str | None = None) -> bytes:
    """글자 하나짜리 폰트 파일."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((500, 0))
    pen.lineTo((500, 700))
    pen.closePath()
    glyph = pen.glyph()
    builder.setupGlyf({".notdef": glyph, "A": glyph})
    builder.setupHorizontalMetrics({".notdef": (600, 0), "A": (600, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    names = {"familyName": family, "styleName": style}
    if typographic:
        names.update({"typographicFamily": typographic[0], "typographicSubfamily": typographic[1]})
    builder.setupNameTable(names)
    builder.setupOS2(usWeightClass=weight, fsSelection=1 if italic else 64)
    builder.setupPost()
    if korean:
        builder.font["name"].setName(korean, 16 if typographic else 1, 3, 1, 0x412)
    if variable:
        builder.setupFvar([("wght", 100, 400, 900, "Weight")], [])
    builder.font.flavor = flavor
    buffer = io.BytesIO()
    builder.save(buffer)
    return buffer.getvalue()


async def test_fonts_and_appearance(client):
    assert (await client.get("/api/fonts")).json() == {"fonts": []}

    regular = make_font("MaruBuri", korean="마루 부리")
    r = await client.post("/api/fonts/upload", params={"name": "MaruBuri-Regular.ttf"}, content=regular)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first == {
        "id": first["id"], "family": "마루 부리", "style": "Regular", "weight": [400, 400], "italic": False,   # 한글 이름이 있으면 그것을 쓴다
        "format": "truetype", "size": len(regular), "file": "MaruBuri-Regular.ttf", "url": f"/api/fonts/{first['id']}/file",
    }
    # 굵은 파일: 굵기별로 나뉜 옛 이름("… Bold") 말고 폰트의 이름을 쓴다. 그래야 한 폰트로 묶인다
    bold = make_font("MaruBuri Bold", weight=700, typographic=("MaruBuri", "Bold"), korean="마루 부리")
    second = (await client.post("/api/fonts/upload", params={"name": r"C:\폰트\MaruBuri-Bold.ttf"}, content=bold)).json()
    assert (second["family"], second["style"], second["weight"], second["file"]) == ("마루 부리", "Bold", [700, 700], "MaruBuri-Bold.ttf")
    packed = (await client.post("/api/fonts/upload", params={"name": "a.woff2"}, content=make_font("Alpha", "Italic", italic=True, flavor="woff2"))).json()
    assert (packed["family"], packed["italic"], packed["format"]) == ("Alpha", True, "woff2")
    wide = (await client.post("/api/fonts/upload", params={"name": "v.ttf"}, content=make_font("Vario", variable=True))).json()
    assert wide["weight"] == [100, 900]                                              # 가변 폰트는 굵기가 범위다

    again = (await client.post("/api/fonts/upload", params={"name": "다른 이름.ttf"}, content=regular)).json()
    assert again == first                                                            # 같은 파일은 하나다
    listed = (await client.get("/api/fonts")).json()["fonts"]
    assert [(f["family"], f["weight"][0]) for f in listed] == [("Alpha", 400), ("Vario", 100), ("마루 부리", 400), ("마루 부리", 700)]

    got = await client.get(first["url"])
    assert got.content == regular and got.headers["content-type"] == "font/ttf" and "immutable" in got.headers["cache-control"]
    assert (await client.get(packed["url"])).headers["content-type"] == "font/woff2"

    for bad, message in [
        (b"hello, this is not a font", "폰트 파일이 아닙니다"),
        (b"ttcf" + b"\x00" * 64, "ttc"),
        (b"OTTO" + b"\x00" * 64, "읽지 못했습니다"),
        (b"", "빈 파일"),
    ]:
        r = await client.post("/api/fonts/upload", params={"name": "x.ttf"}, content=bad)
        assert r.status_code == 400 and message in r.json()["error"], (message, r.text)
    assert len((await client.get("/api/fonts")).json()["fonts"]) == 4

    fonts_dir = client.app.state.ctx.paths.fonts
    assert (await client.delete(f"/api/fonts/{first['id']}")).json() == {"status": "ok"}
    assert not list(fonts_dir.glob(f"{first['id']}.*")) and len(list(fonts_dir.glob("*.ttf"))) == 2
    assert (await client.delete(f"/api/fonts/{first['id']}")).status_code == 404
    assert (await client.get(first["url"])).status_code == 404
    assert (await client.get("/api/fonts/fonts/file")).status_code == 404            # 목록에 없는 이름으로는 아무 파일도 못 꺼낸다

    # 화면 설정: 엔진은 내용을 보지 않고 그대로 맡아 둔다. 모델 설정과는 따로다
    assert (await client.get("/api/appearance")).json() == {}
    look = {"fonts": {"body": {"family": "마루 부리", "size": 17}}, "styles": {"quote": {"color": "#0b4d9b"}}}
    assert (await client.put("/api/appearance", json=look)).json() == look
    assert (await client.get("/api/appearance")).json() == look
    assert (await client.put("/api/appearance", json=[1, 2])).status_code == 400
    assert (await client.put("/api/appearance", content=b"{")).status_code == 400
    assert (await client.put("/api/appearance", content=b'{"a": "' + b"x" * 210_000 + b'"}')).status_code == 413
    assert (await client.get("/api/appearance")).json() == look
