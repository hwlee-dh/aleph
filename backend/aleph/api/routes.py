"""HTTP API — 설정, 제공자, 프리셋, 작업, 실행.

작업 공간(문서, 원고, 파일)의 경로는 workspace_routes.py에 있다. 명세는 backend/API.md.

모든 핸들러는 `get_ctx`로 `AppContext`를 받는다. 여러 사용자를 받게 되면
`get_ctx`가 요청의 사용자에 맞는 컨텍스트를 고르도록 바꾸면 된다.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .. import archive
from ..agent import compaction
from ..agent.deps import RunDeps
from ..agent.history import load_history, sanitize_history, save_history
from ..agent.loop import MODES
from ..agent.manager import RunBusyError
from ..context import AppContext
from ..fonts import FontError
from ..presets.store import Mode, Preset, PresetError, clamp, summary_tool
from ..process_log import compile_process_log
from ..providers.catalog import list_models
from ..providers.kinds import KINDS
from ..providers.store import ProviderConfig, ProviderError
from ..settings import VERSION, VERSION_DATE
from ..tools.agent_tools import agent_tool_catalog
from ..tools.definitions import find_tool
from ..workspace import undo
from ..workspace.documents import INPUT, MATERIALS, josa

router = APIRouter(prefix="/api")


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


Ctx = Depends(get_ctx)


def _session(ctx: AppContext, session_id: str) -> str:
    """작업 id를 검증하고 있는지 확인한다."""
    if not ctx.sessions.exists(session_id):
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return session_id


def _conversation(ctx: AppContext, session_id: str, conversation: str | None) -> str:
    """대화 id. 안 주면 지금 보고 있는 대화. 없는 대화면 404."""
    _session(ctx, session_id)
    if not conversation:
        return ctx.state(session_id).conversation
    if not ctx.sessions.valid_conversation(conversation) or ctx.sessions.conversation(session_id, conversation) is None:
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return conversation


# ====================================================================== 기본

@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/meta")
async def meta():
    return {
        "version": VERSION,
        "version_date": VERSION_DATE,
        "provider_kinds": [k.to_dict() for k in KINDS.values()],
        "modes": MODES,
        "agent_tools": agent_tool_catalog(),
        # 요약 도구를 새로 넣을 때 채울 글 (지운 도구를 `+ 도구`로 되살릴 때)
        "summary_tool": summary_tool().model_dump(),
    }


# =================================================================== 제공자

class ProviderBody(BaseModel):
    kind: str
    label: str = ""
    api_key: str | None = None  # None이면 기존 키 유지, 빈 문자열도 유지 (지우려면 DELETE .../key)
    base_url: str = ""
    extra: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


@router.get("/providers")
async def providers(ctx: AppContext = Ctx):
    return {"providers": [ctx.providers.public(p) for p in ctx.providers.list()]}


@router.put("/providers/{provider_id}")
async def put_provider(provider_id: str, body: ProviderBody, ctx: AppContext = Ctx):
    try:
        saved = ctx.providers.upsert(ProviderConfig(
            id=provider_id,
            kind=body.kind,
            label=body.label,
            api_key=(body.api_key or "").strip(),
            base_url=body.base_url.strip(),
            extra={k: v.strip() for k, v in body.extra.items() if v and v.strip()},
            enabled=body.enabled,
        ))
    except ProviderError as e:
        raise HTTPException(400, str(e))
    return ctx.providers.public(saved)


@router.delete("/providers/{provider_id}/key")
async def delete_provider_key(provider_id: str, ctx: AppContext = Ctx):
    ctx.providers.clear_key(provider_id)
    p = ctx.providers.get(provider_id)
    if p is None:
        raise HTTPException(404, "제공자를 찾을 수 없습니다.")
    return ctx.providers.public(p)


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str, ctx: AppContext = Ctx):
    if not ctx.providers.delete(provider_id):
        raise HTTPException(404, "제공자를 찾을 수 없습니다.")
    return {"status": "ok"}


@router.get("/providers/{provider_id}/models")
async def provider_models(provider_id: str, refresh: bool = False, ctx: AppContext = Ctx):
    return await list_models(provider_id, ctx.providers, refresh=refresh)


# ===================================================================== 설정
# 모델 설정은 프리셋에 있다 (`/presets/{id}`). 여기에는 화면 설정과 폰트만 있다.

@router.get("/appearance")
async def get_appearance(ctx: AppContext = Ctx):
    """화면 설정. 모양은 화면이 정하고 엔진은 그대로 맡아 둔다."""
    return ctx.settings.appearance()


@router.put("/appearance")
async def put_appearance(request: Request, ctx: AppContext = Ctx):
    raw = await request.body()
    if len(raw) > 200 * 1024:
        raise HTTPException(413, "화면 설정이 너무 큽니다.")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "화면 설정을 읽지 못했습니다.")
    if not isinstance(data, dict):
        raise HTTPException(400, "화면 설정은 객체여야 합니다.")
    return ctx.settings.save_appearance(data)


# ===================================================================== 폰트

@router.get("/fonts")
async def list_fonts(ctx: AppContext = Ctx):
    return {"fonts": ctx.fonts.list()}


@router.post("/fonts/upload")
async def upload_font(name: str, request: Request, ctx: AppContext = Ctx):
    """폰트 파일(ttf, otf, woff, woff2)을 올린다. 본문은 파일 바이트 그대로."""
    try:
        return ctx.fonts.add(name, await request.body())
    except FontError as e:
        raise HTTPException(400, str(e))


@router.get("/fonts/{font_id}/file")
async def font_file(font_id: str, ctx: AppContext = Ctx):
    found = ctx.fonts.file(font_id)
    if found is None:
        raise HTTPException(404, "폰트를 찾을 수 없습니다.")
    path, media = found
    # id가 내용의 해시라서 같은 주소의 내용은 바뀌지 않는다
    return Response(path.read_bytes(), media_type=media, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.delete("/fonts/{font_id}")
async def delete_font(font_id: str, ctx: AppContext = Ctx):
    if not ctx.fonts.delete(font_id):
        raise HTTPException(404, "폰트를 찾을 수 없습니다.")
    return {"status": "ok"}


# =================================================================== 프리셋

@router.get("/presets")
async def list_presets(ctx: AppContext = Ctx):
    return {"presets": ctx.presets.list()}


def _download(name: str, data: bytes) -> Response:
    return Response(
        data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"},
    )


@router.post("/import")
async def import_file(request: Request, ctx: AppContext = Ctx):
    """내보낸 파일(.aleph, .alephpreset)을 들여온다. 본문은 파일 바이트 그대로. 종류는 파일 안을 보고 가린다."""
    data = await request.body()
    if not data:
        raise HTTPException(400, "빈 파일입니다.")
    try:
        return archive.import_file(ctx, data)
    except archive.ArchiveError as e:
        raise HTTPException(400, str(e))


@router.get("/presets/{preset_id}/archive")
async def export_preset(preset_id: str, ctx: AppContext = Ctx):
    """프리셋을 `.alephpreset` 파일 하나로 내보낸다."""
    try:
        packed = archive.export_preset(ctx, preset_id)
    except PresetError as e:
        raise HTTPException(422, str(e))
    if packed is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    return _download(*packed)


@router.get("/presets/{preset_id}")
async def get_preset(preset_id: str, ctx: AppContext = Ctx):
    try:
        preset = ctx.presets.get(preset_id)
    except PresetError as e:
        raise HTTPException(422, str(e))
    if preset is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    return preset


@router.put("/presets/{preset_id}")
async def put_preset(preset_id: str, body: Preset, ctx: AppContext = Ctx):
    body.id = preset_id
    try:
        return ctx.presets.save(clamp(body))
    except PresetError as e:
        raise HTTPException(400, str(e))


@router.patch("/presets/{preset_id}")
async def patch_preset(preset_id: str, body: dict, ctx: AppContext = Ctx):
    """프리셋의 칸 몇 개만 고친다. 채팅창에서 모델이나 추론 수준을 바꿀 때 쓴다 (패널이 고치는 다른 칸을 덮지 않는다)."""
    try:
        current = ctx.presets.get(preset_id)
    except PresetError as e:
        raise HTTPException(422, str(e))
    if current is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    fixed = {"id", "builtin"}
    unknown = [k for k in body if k not in Preset.model_fields or k in fixed]
    if unknown:
        raise HTTPException(400, f"고칠 수 없는 칸입니다: {', '.join(unknown)}")
    try:
        merged = Preset(**{**current.model_dump(), **body})
        return ctx.presets.save(clamp(merged))
    except PresetError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class DuplicateBody(BaseModel):
    name: str = ""


@router.post("/presets/{preset_id}/duplicate")
async def duplicate_preset(preset_id: str, body: DuplicateBody, ctx: AppContext = Ctx):
    """프리셋을 새 id로 복제한다 ('다른 이름으로 저장'도 이것)."""
    try:
        copy = ctx.presets.duplicate(preset_id, body.name)
    except PresetError as e:
        raise HTTPException(400, str(e))
    if copy is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    return copy


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str, ctx: AppContext = Ctx):
    result = ctx.presets.delete(preset_id)
    if result == "missing":
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    if result == "readonly":
        raise HTTPException(400, "기본 제공 프리셋은 지울 수 없습니다.")
    return {"status": result}


# ===================================================================== 작업

class NameBody(BaseModel):
    name: str


class CreateSessionBody(BaseModel):
    name: str
    preset_id: str | None = None


@router.get("/sessions")
async def list_sessions(ctx: AppContext = Ctx):
    running = set(ctx.runs.running_sessions())
    sessions = ctx.sessions.list_sessions()
    for s in sessions:
        s["running"] = s["id"] in running
        s["preset_id"] = ctx.state(s["id"]).preset_id   # 지워진 프리셋을 가리키고 있었으면 지금 대신 쓰이는 것
        docs = ctx.docs(s["id"])
        s["chars"] = docs.manuscript.overview()["chars"]
        s["materials"] = len(docs.paths(MATERIALS))
    return {"sessions": sessions}


@router.post("/sessions")
async def create_session(body: CreateSessionBody, ctx: AppContext = Ctx):
    if body.preset_id and ctx.presets.get(body.preset_id) is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    return ctx.create_session(body.name.strip() or "새 작업", body.preset_id)


@router.get("/sessions/{session_id}/archive")
async def export_session(session_id: str, ctx: AppContext = Ctx):
    """작업을 통째로 `.aleph` 파일 하나로 내보낸다 (문서, 원고, 버전 기록, 대화, 도구 실행 기록, 쓰던 프리셋)."""
    _session(ctx, session_id)
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "실행 중인 작업은 내보낼 수 없습니다. 끝난 뒤에 해야 합니다.")
    return _download(*archive.export_session(ctx, session_id))


@router.patch("/sessions/{session_id}")
async def rename_session(session_id: str, body: NameBody, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    ctx.sessions.rename_session(session_id, body.name.strip() or "새 작업")
    return {"status": "ok"}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "실행 중인 작업은 지울 수 없습니다. 먼저 중단해야 합니다.")
    ctx.sessions.delete_session(session_id)
    return {"status": "ok"}


class StateBody(BaseModel):
    preset_id: str | None = None
    mode: Mode | None = None
    bypass_locks: bool | None = None
    auto_compact: bool | None = None
    conversation: str | None = None   # 지금 보고 있는 대화


def state_dict(ctx: AppContext, session_id: str) -> dict:
    state = ctx.state(session_id)
    preset = ctx.presets.get(state.preset_id) if state.preset_id else None
    model = ctx.effective_model(preset)
    return {
        **state.model_dump(),
        "model": preset.model if preset else "",   # 프리셋에 적힌 모델 (쓸 수 없는 것이어도 그대로)
        "effective_model": model,                  # 실제로 쓰일 모델. 비었으면 골라야 한다
        "available": ctx.available(model),
    }


@router.get("/sessions/{session_id}/state")
async def get_state(session_id: str, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    return state_dict(ctx, session_id)


@router.put("/sessions/{session_id}/state")
async def put_state(session_id: str, body: StateBody, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    if body.preset_id is not None and ctx.presets.get(body.preset_id) is None:
        raise HTTPException(404, "프리셋을 찾을 수 없습니다.")
    if body.conversation is not None:
        _conversation(ctx, session_id, body.conversation or None)
    ctx.set_state(session_id, **body.model_dump())
    return state_dict(ctx, session_id)


@router.get("/sessions/{session_id}/events")
async def session_events(session_id: str, conversation: str = "", ctx: AppContext = Ctx):
    """대화 하나의 기록. conversation을 안 주면 지금 보고 있는 대화. `run`은 작업에서 도는 실행이다 (다른 대화의 것일 수 있다)."""
    cid = _conversation(ctx, session_id, conversation)
    return {
        "conversation_id": cid,
        "events": ctx.sessions.read_events(session_id, cid),
        "run": ctx.runs.status(session_id),
    }


# ===================================================================== 대화

class ConversationBody(BaseModel):
    name: str = ""


def _conversations(ctx: AppContext, session_id: str) -> dict:
    run = ctx.runs.status(session_id)
    running = run.get("conversation_id") if run.get("running") else None
    items = ctx.sessions.conversations(session_id)
    for c in items:
        c["running"] = c["id"] == running
    return {"conversations": items, "current": ctx.state(session_id).conversation}


@router.get("/sessions/{session_id}/conversations")
async def list_conversations(session_id: str, ctx: AppContext = Ctx):
    """이 작업의 대화들 (만든 순서). 문서와 원고는 대화들이 같이 쓴다."""
    _session(ctx, session_id)
    return _conversations(ctx, session_id)


@router.post("/sessions/{session_id}/conversations")
async def create_conversation(session_id: str, body: ConversationBody | None = None, ctx: AppContext = Ctx):
    """새 대화를 만들고 그것을 보고 있는 대화로 둔다. 실행 중이어도 만들 수 있다 (보내는 것은 그 실행이 끝난 뒤에)."""
    _session(ctx, session_id)
    created = ctx.sessions.create_conversation(session_id, (body.name if body else "").strip()[:80])
    ctx.set_state(session_id, conversation=created["id"])
    return {**created, "running": False}


@router.patch("/sessions/{session_id}/conversations/{conversation}")
async def rename_conversation(session_id: str, conversation: str, body: ConversationBody, ctx: AppContext = Ctx):
    cid = _conversation(ctx, session_id, conversation)
    return ctx.sessions.update_conversation(session_id, cid, name=body.name.strip()[:80])


@router.delete("/sessions/{session_id}/conversations/{conversation}")
async def delete_conversation(session_id: str, conversation: str, ctx: AppContext = Ctx):
    """대화의 기록과 기억을 지운다. 문서와 원고는 그대로다. 마지막 대화를 지우면 빈 대화 하나가 남는다."""
    cid = _conversation(ctx, session_id, conversation)
    if ctx.runs.status(session_id).get("running") and ctx.runs.status(session_id).get("conversation_id") == cid:
        raise HTTPException(409, "실행 중인 대화는 지울 수 없습니다. 먼저 중단해야 합니다.")
    if session_id in ctx.runs._held:
        raise HTTPException(409, "대화를 압축하는 중입니다. 끝난 뒤에 해야 합니다.")
    ctx.sessions.delete_conversation(session_id, cid)
    undo.forget_conversation(ctx.sessions, session_id, cid)
    return _conversations(ctx, session_id)


@router.get("/sessions/{session_id}/process-log")
async def process_log(session_id: str, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    return {
        "content": compile_process_log(ctx.sessions, session_id),
        "session_name": ctx.sessions.meta(session_id).get("name") or session_id[:8],
    }


# ===================================================================== 실행

class RunBody(BaseModel):
    goal: str
    tool: str | None = None   # 사용자가 지정한 도구 (`/집필 …`)
    conversation: str | None = None   # 보낼 대화. 안 주면 지금 보고 있는 대화


def _start(
    ctx: AppContext, session_id: str, *, goal: str, tool: str, kind: str, trial: dict | None = None,
    conversation: str | None = None,
) -> dict:
    cid = _conversation(ctx, session_id, conversation)
    try:
        config = ctx.run_config(session_id, goal=goal, tool=tool, kind=kind, conversation=cid)
        config.trial = trial
    except PresetError as e:
        raise HTTPException(422, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if tool:
        found = find_tool(config.preset.enabled_tools(), tool)
        if found is None:
            raise HTTPException(404, f"도구 '{tool}'{josa(tool, '을', '를')} 찾을 수 없습니다.")
        config.tool = found.name
    try:
        run_id = ctx.runs.start(session_id, config)
    except RunBusyError as e:
        raise HTTPException(409, str(e))
    ctx.set_state(session_id, conversation=cid)   # 보낸 대화가 보고 있는 대화가 된다
    return {"run_id": run_id, "conversation_id": cid}


@router.post("/sessions/{session_id}/runs")
async def start_run(session_id: str, body: RunBody, ctx: AppContext = Ctx):
    """에이전트에게 요청을 보낸다. 모드·모델·프리셋·권한 무시는 작업의 상태에서 읽는다."""
    _session(ctx, session_id)
    if not body.goal.strip():
        raise HTTPException(400, "요청 내용이 비어 있습니다.")
    return _start(
        ctx, session_id, goal=body.goal.strip(), tool=(body.tool or "").strip(), kind="agent", conversation=body.conversation,
    )


class ToolRunBody(BaseModel):
    trial: bool = False            # 시험 실행: 출력을 건드리지 않고 결과를 기록에만 남긴다
    input_seq: int | None = None   # 그 번호의 도구 실행에 들어갔던 입력을 그대로 다시 쓴다 (시험 실행에서만)
    model: str = ""                # 이번에만 쓸 모델 (시험 실행에서만)
    conversation: str | None = None   # 기록을 남길 대화. 안 주면 지금 보고 있는 대화


@router.post("/sessions/{session_id}/tools/{name}/run")
async def run_tool(session_id: str, name: str, body: ToolRunBody | None = None, ctx: AppContext = Ctx):
    """에이전트를 거치지 않고 도구를 돌린다. 그냥 부르면 지금 입력으로 돌려 출력에 쓰고, trial이면 견주기 위한 시험 실행이다."""
    _session(ctx, session_id)
    body = body or ToolRunBody()
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "이 작업에서 이미 실행이 진행 중입니다.")
    trial: dict | None = None
    if body.trial:
        trial = {"input": None, "base_seq": None, "model": body.model.strip()}
        if body.input_seq is not None:
            from .workspace_routes import _tool_runs

            base = next((r for r in _tool_runs(ctx, session_id) if r["seq"] == body.input_seq), None)
            if base is None or not base.get("input"):
                raise HTTPException(404, "그 번호의 도구 실행 기록이 없습니다.")
            trial.update({"input": base["input"], "base_seq": base.get("base_seq") or base["seq"]})
        if trial["model"] and not ctx.usable(trial["model"]):
            raise HTTPException(400, f"모델 '{trial['model']}'{josa(trial['model'], '을', '를')} 쓸 수 없습니다. 제공자와 키를 확인해야 합니다.")
    if (trial is None or trial["input"] is None) and not ctx.docs(session_id).text(INPUT).strip():
        raise HTTPException(400, "입력이 비어 있습니다. 도구에 넘길 글을 입력에 먼저 써야 합니다.")
    state = ctx.state(session_id)
    preset = ctx.presets.get(state.preset_id)
    tool = find_tool(preset.enabled_tools(), name) if preset else None
    if tool is None:
        unfinished = find_tool(preset.tools, name) if preset else None
        if unfinished is not None and unfinished.enabled:
            raise HTTPException(400, f"도구 '{unfinished.title}'의 지시문이 비어 있습니다. 지시문을 써야 돌릴 수 있습니다.")
        raise HTTPException(404, f"도구 '{name}'{josa(name, '을', '를')} 찾을 수 없습니다.")
    return _start(
        ctx, session_id, goal=f"/{tool.title}", tool=tool.name, kind="tool", trial=trial, conversation=body.conversation,
    )


class RevertBody(BaseModel):
    force: bool = False


@router.get("/sessions/{session_id}/runs/last")
async def last_run(session_id: str, ctx: AppContext = Ctx):
    """가장 최근의 실행과, 그것을 되돌리면 무엇이 달라지는지."""
    _session(ctx, session_id)
    return undo.last_run(ctx.sessions, session_id, running=ctx.runs.is_running(session_id))


@router.post("/sessions/{session_id}/runs/{run_id}/revert")
async def revert_run(session_id: str, run_id: str, body: RevertBody | None = None, ctx: AppContext = Ctx):
    """가장 최근의 실행이 바꾼 것을 한 번에 되돌린다. 그 뒤에 사용자가 고친 문서는 force일 때 그대로 둔다."""
    _session(ctx, session_id)
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "실행 중에는 되돌릴 수 없습니다. 먼저 중단해야 합니다.")
    try:
        return undo.revert(ctx.sessions, session_id, run_id, force=bool(body and body.force))
    except undo.RevertError as e:
        if e.touched_later:
            return JSONResponse({"error": str(e), "touched_later": e.touched_later}, status_code=409)
        raise HTTPException(409, str(e))


@router.post("/sessions/{session_id}/conversation/reset")
async def reset_conversation(session_id: str, conversation: str = "", ctx: AppContext = Ctx):
    """문서는 두고 그 대화에서 에이전트가 기억하는 것만 비운다. 기록은 같은 대화에 이어진다. (새 대화는 `POST …/conversations`.)"""
    cid = _conversation(ctx, session_id, conversation)
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "실행 중에는 대화를 비울 수 없습니다. 먼저 중단해야 합니다.")
    undo.reset_conversation(ctx.sessions, session_id, cid)
    return {"status": "ok", "conversation_id": cid}


@router.post("/sessions/{session_id}/conversation/compact")
async def compact_conversation(session_id: str, conversation: str = "", ctx: AppContext = Ctx):
    """대화를 지금 줄인다 (채팅창의 `지금 압축`). 한도를 넘지 않았어도 앞부분을 요약으로 바꾼다."""
    cid = _conversation(ctx, session_id, conversation)
    if ctx.runs.is_running(session_id):
        raise HTTPException(409, "실행 중에는 압축할 수 없습니다. 끝난 뒤에 해야 합니다.")
    try:
        config = ctx.run_config(session_id)
    except PresetError as e:
        raise HTTPException(422, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    path = ctx.history_path(session_id, cid)
    messages = sanitize_history(load_history(path))
    deps = RunDeps(
        session_id=session_id, sessions=ctx.sessions, docs=ctx.docs(session_id), hitl=None,  # type: ignore[arg-type]
        llm=ctx.llm, mode=config.mode, agent_model=config.agent_model, auxiliary_model=config.auxiliary_model,
        auxiliary_thinking=config.auxiliary_thinking, auxiliary_max_output_tokens=config.auxiliary_max_output_tokens,
        conversation=cid,
    )
    with ctx.runs.hold(session_id):   # 요약을 기다리는 동안 실행이 시작되면 그 실행의 기억이 덮인다
        compacted, info = await compaction.compact_messages(
            messages, config.context_budget, summarize=compaction.summarizer(deps), force=True
        )
        if info is None:
            return {"compacted": False}
        if info.get("failed"):
            raise HTTPException(502, f"대화를 요약하지 못했습니다: {info.get('error', '')}")
        save_history(path, sanitize_history(compacted))
    ctx.sessions.update_conversation(session_id, cid, context_tokens=int(info["tokens_after"]))
    event = {"type": "compaction", "manual": True, "conversation_id": cid, **info}
    ctx.sessions.append_event(session_id, event, cid)
    return {"compacted": True, "conversation_id": cid, **info}


@router.post("/sessions/{session_id}/stop")
async def stop_run(session_id: str, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    return {"stopped": ctx.runs.stop(session_id)}


class SteerBody(BaseModel):
    text: str


@router.post("/sessions/{session_id}/steer")
async def steer(session_id: str, body: SteerBody, ctx: AppContext = Ctx):
    """실행을 멈추지 않고 에이전트에게 말을 끼워 넣는다. 다음에 모델을 부를 때 전달된다."""
    _session(ctx, session_id)
    if not body.text.strip():
        raise HTTPException(400, "보낼 말이 비어 있습니다.")
    if not ctx.runs.steer(session_id, body.text.strip()):
        raise HTTPException(409, "에이전트가 실행 중이 아닙니다. 요청으로 보내면 됩니다.")
    return {"status": "queued"}


class RespondBody(BaseModel):
    event_id: str
    response: str


@router.post("/sessions/{session_id}/respond")
async def respond(session_id: str, body: RespondBody, ctx: AppContext = Ctx):
    _session(ctx, session_id)
    if not ctx.runs.respond(session_id, body.event_id, body.response):
        raise HTTPException(409, "답을 기다리는 질문이 없습니다 (이미 답했거나 실행이 끝났습니다).")
    return {"status": "ok"}


@router.get("/sessions/{session_id}/stream")
async def stream(session_id: str, after: int = 0, ctx: AppContext = Ctx):
    """진행 중인 실행의 이벤트를 SSE로 흘려보낸다. 끊겼다 다시 붙으면 after 이후부터 이어 받는다."""
    _session(ctx, session_id)

    async def gen():
        iterator = ctx.runs.stream(session_id, after).__aiter__()
        pending: asyncio.Task | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.ensure_future(iterator.__anext__())
                done, _ = await asyncio.wait({pending}, timeout=15)
                if not done:
                    yield ": ping\n\n"  # 사용자 답을 오래 기다리는 동안 연결이 끊기지 않게
                    continue
                task, pending = pending, None
                try:
                    event = task.result()
                except StopAsyncIteration:
                    break
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            # 화면이 떠나면(작업을 바꾸거나 새로 고침) 여기로 온다. 기다리던 것을 마저 걷고 나서 닫는다.
            if pending is not None:
                pending.cancel()
                with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration, Exception):
                    await pending
            with contextlib.suppress(RuntimeError):
                await iterator.aclose()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
