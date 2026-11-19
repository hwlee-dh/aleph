"""작업 공간의 HTTP API — 입력·출력·자료·원고, 파일 올리기, 내보내기. 명세는 backend/API.md.

사람이 이 API로 하는 변경은 수정 방지나 모드와 상관없이 바로 반영되고, 기록에는
'user'로 남는다. 그 관문들은 에이전트와 도구에게만 걸린다.
"""

from __future__ import annotations

import mimetypes
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from .. import files
from ..context import AppContext
from ..workspace.documents import (
    INPUT,
    MANUSCRIPT,
    MATERIALS,
    OUTPUT,
    Change,
    DocError,
    DocWorkspace,
    kind_of,
    normalize_path,
    show_path,
    zone_of,
)
from ..workspace.manuscript import END
from .routes import Ctx, _conversation, _session, state_dict

router = APIRouter(prefix="/api/sessions/{session_id}")


def _docs(ctx: AppContext, session_id: str) -> DocWorkspace:
    _session(ctx, session_id)
    return ctx.docs(session_id)


def _bad(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


def _context_budget(ctx: AppContext, session_id: str) -> int:
    """이 작업이 쓰는 프리셋의 컨텍스트 한도."""
    preset = ctx.presets.get(ctx.state(session_id).preset_id)
    return preset.context_budget if preset is not None else 0


# ================================================================ 한 번에 받는 작업 공간

@router.get("/workspace")
async def workspace(session_id: str, conversation: str = "", ctx: AppContext = Ctx):
    """작업 공간 전체. `context`는 대화마다 다르다 (conversation을 안 주면 지금 보고 있는 대화)."""
    docs = _docs(ctx, session_id)
    cid = _conversation(ctx, session_id, conversation)
    current = ctx.sessions.conversation(session_id, cid) or {}
    return {
        "state": state_dict(ctx, session_id),
        "input": docs.slot(INPUT),
        "output": docs.slot(OUTPUT),
        "materials": docs.materials(),
        "folders": docs.folders(),   # 자료의 폴더 전부. 빈 폴더는 여기에만 나온다
        "flags": docs.flags(),
        "manuscript": docs.manuscript.overview(),
        "context": {
            "conversation_id": cid,
            "tokens": int(current.get("context_tokens") or 0),
            "budget": _context_budget(ctx, session_id),
        },
    }


# ================================================================ 문서

class DocBody(BaseModel):
    path: str
    content: str


class MoveBody(BaseModel):
    source: str
    destination: str


class FolderBody(BaseModel):
    path: str


class FlagsBody(BaseModel):
    path: str
    locked: bool | None = None
    note: bool | None = None


class RestoreBody(BaseModel):
    path: str
    hash: str


@router.get("/docs/content")
async def get_doc(session_id: str, path: str, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    try:
        target = docs.resolve(path)
    except DocError as e:
        raise _bad(e)
    if not target or docs.is_folder(target):
        raise HTTPException(400, "문서 경로가 아닙니다.")
    content = docs.get(target)
    if content is None:
        if zone_of(target) in ("input", "output"):
            content = ""
        elif docs.exists(target):
            content = ""   # 이미지 같은 파일. 내용은 /files로 받는다
        else:
            raise HTTPException(404, "문서를 찾을 수 없습니다.")
    return {
        "path": show_path(target),
        "content": content,
        "kind": kind_of(target),
        "locked": docs.locked(target),
        "note": docs.noted(target),
    }


@router.put("/docs/content")
async def put_doc(session_id: str, body: DocBody, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    try:
        change = docs.plan_write(body.path, body.content)
        if change.old != change.content:
            docs.apply(change, by="user")
    except DocError as e:
        raise _bad(e)
    return {"path": show_path(change.path), "created": change.old is None}


@router.delete("/docs/content")
async def delete_doc(session_id: str, path: str, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    try:
        target = docs.resolve(path)
        if zone_of(target) == "material" and docs.is_folder(target):
            docs.delete_folder(target, by="user")
        elif zone_of(target) in ("input", "output"):
            docs.clear(INPUT if zone_of(target) == "input" else OUTPUT, by="user")
        else:
            docs.apply(docs.plan_delete(path), by="user")
    except DocError as e:
        raise _bad(e)
    return {"status": "ok"}


@router.post("/docs/folders")
async def create_folder(session_id: str, body: FolderBody, ctx: AppContext = Ctx):
    """자료에 빈 폴더를 만든다. 사용자가 만든 폴더는 안이 비어도 남는다."""
    docs = _docs(ctx, session_id)
    try:
        return {"path": docs.create_folder(body.path)}
    except DocError as e:
        raise _bad(e)


@router.post("/docs/move")
async def move_doc(session_id: str, body: MoveBody, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    try:
        source = docs.resolve(body.source)
        if zone_of(source) == "material" and docs.is_folder(source):
            moved = docs.move_folder(source, body.destination, by="user")
            return {"path": normalize_path(body.destination, allow_folder=True), "moved": [show_path(p) for p in moved]}
        change = docs.plan_move(body.source, body.destination)
        docs.apply(change, by="user")
    except DocError as e:
        raise _bad(e)
    return {"path": show_path(change.dest)}


@router.put("/flags")
async def set_flags(session_id: str, body: FlagsBody, ctx: AppContext = Ctx):
    """수정 방지·노트를 켜거나(true) 끄거나(false) 상속으로 되돌린다(null). 본문에 든 것만 바뀐다."""
    docs = _docs(ctx, session_id)
    try:
        for name in ("locked", "note"):
            if name in body.model_fields_set:
                docs.set_flag(body.path, name, getattr(body, name))
    except DocError as e:
        raise _bad(e)
    return {"flags": docs.flags()}


@router.get("/docs/history")
async def doc_history(session_id: str, path: str, ctx: AppContext = Ctx):
    """문서 하나의 버전 기록 — 누가 언제 고쳤고, 도구가 썼다면 어떤 실행이었는지."""
    docs = _docs(ctx, session_id)
    try:
        entries = docs.history(path)
    except DocError as e:
        raise _bad(e)
    runs = {r["tool_call_id"]: r for r in _tool_runs(ctx, session_id) if r.get("tool_call_id")}
    proposals = {p["id"]: p for p in docs.proposals()}
    for e in entries:
        e["path"] = show_path(e["path"])
        if e.get("to"):
            e["to"] = show_path(e["to"])
        origin = e.get("origin") or {}
        run = runs.get(origin.get("tool_call_id"))
        if run and e["by"].startswith("tool:"):
            e["tool_run"] = {k: run.get(k) for k in ("tool", "label", "model", "duration_ms")} | {"run_seq": run["seq"]}
        proposal = proposals.get(origin.get("proposal_id"))
        if proposal:
            e["proposal"] = {"id": proposal["id"], "status": proposal["status"], "note": proposal.get("note", "")}
    return {"entries": entries}


@router.get("/docs/version")
async def doc_version(session_id: str, hash: str, ctx: AppContext = Ctx):
    content = _docs(ctx, session_id).version(hash)
    if content is None:
        raise HTTPException(404, "그 버전을 찾을 수 없습니다.")
    return {"content": content}


@router.post("/docs/restore")
async def restore_doc(session_id: str, body: RestoreBody, ctx: AppContext = Ctx):
    """예전 버전으로 복원한다. 지운 문서를 되살리는 것도 이걸로 한다 (지운 장면은 원고 끝에 새 장면으로 들어간다)."""
    docs = _docs(ctx, session_id)
    content = docs.version(body.hash)
    if content is None:
        raise HTTPException(404, "그 버전을 찾을 수 없습니다.")
    origin = {"restored_from": body.hash}
    try:
        raw = body.path.strip().strip("/").removesuffix(".md")
        if raw.startswith(f"{MANUSCRIPT}/") and not (docs.root / f"{raw}.md").is_file():
            # 지운 장면은 원고 끝에 새 장면으로 돌아온다.
            scene_id = docs.manuscript.insert(content, by="user", origin={**origin, "restored_path": raw}, allow_empty=True)
            return {"path": f"{MANUSCRIPT}/{scene_id}"}
        change = docs.plan_write(body.path, content)
        docs.apply(change, by="user", origin=origin)
    except DocError as e:
        raise _bad(e)
    return {"path": show_path(change.path)}


@router.get("/deleted")
async def deleted(session_id: str, ctx: AppContext = Ctx):
    """지워진 채로 있는 글 문서와 장면 (누가 지웠든). `docs/restore`에 `path`와 `hash`를 주면 복원된다."""
    return {"items": _docs(ctx, session_id).deleted()}


@router.get("/docs/resolve")
async def resolve_ref(session_id: str, ref: str, ctx: AppContext = Ctx):
    """`@include`가 가리키는 것. 화면이 눌렀을 때 무엇을 열지 정하려고 쓴다."""
    docs = _docs(ctx, session_id)
    try:
        target = docs.resolve(ref)
    except DocError:
        return {"kind": "missing", "path": ref, "title": ref}
    zone = zone_of(target)
    if zone == "manuscript":
        if target == MANUSCRIPT:
            return {"kind": "manuscript", "path": MANUSCRIPT, "title": MANUSCRIPT}
        name = target.split("/", 1)[1]
        if name.startswith("c"):
            return {"kind": "chapter", "path": target, "title": target}
        scene_id = show_path(name)
        return {"kind": "scene", "path": f"{MANUSCRIPT}/{scene_id}", "title": docs.manuscript.label(scene_id)}
    if zone == "material" and docs.is_folder(target):
        return {"kind": "folder", "path": target, "title": target}
    if zone in ("input", "output") or docs.exists(target):
        return {"kind": "doc", "path": show_path(target), "title": show_path(target)}
    return {"kind": "missing", "path": show_path(target), "title": show_path(target)}


# ================================================================ 파일

@router.get("/files")
async def get_file(session_id: str, path: str, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    found = files.image_bytes(docs, path)   # 원고에 `등대%20그림.png`처럼 적힌 경로도 찾는다
    if found is None:
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    target, data = found
    return Response(data, media_type=mimetypes.guess_type(target)[0] or "application/octet-stream")


@router.post("/upload")
async def upload(session_id: str, name: str, request: Request, folder: str = "", ctx: AppContext = Ctx):
    """파일을 올린다. 글 파일은 글을 뽑아 통짜 문서로, 이미지는 그대로 자료에 넣는다."""
    docs = _docs(ctx, session_id)
    data = await request.body()
    if not data:
        raise HTTPException(400, "빈 파일입니다.")
    if len(data) > files.MAX_UPLOAD:
        raise HTTPException(413, "파일이 너무 큽니다 (40MB 이내).")
    filename = PurePosixPath(name.replace("\\", "/")).name.strip()
    if not filename:
        raise HTTPException(400, "파일 이름이 없습니다.")
    try:
        base = normalize_path(folder, allow_folder=True) if folder.strip() else ""
        if base and zone_of(base) != "material":
            base = f"{MATERIALS}/{base}"
        if files.is_image(filename):
            path = docs.save_file(f"{base or f'{MATERIALS}/삽화'}/{filename}", data, by="user")
            return {"path": path, "kind": "image", "chars": 0, "note": ""}
        try:
            text = files.extract_text(filename, data)
        except files.ExtractError as e:
            if not e.no_text:
                raise
            # 스캔한 PDF: 글은 못 뽑지만 파일은 멀쩡하다. 그대로 넣어 두면 에이전트가 직접 볼 수 있다.
            path = docs.save_file(f"{base or f'{MATERIALS}/올린 글'}/{filename}", data, by="user")
            return {
                "path": path, "kind": "file", "chars": 0,
                "note": "글을 뽑지 못해 파일 그대로 넣었습니다. 이미지를 볼 수 있는 모델이면 에이전트가 읽을 수 있습니다.",
            }
        stem = PurePosixPath(filename).stem
        target = docs.free_path(normalize_path(f"{base or f'{MATERIALS}/올린 글'}/{stem}"))
        docs.apply(Change("write", target, content=text, old=None), by="user", origin={"uploaded": filename})
    except files.ExtractError as e:
        raise HTTPException(422, str(e))
    except DocError as e:
        raise _bad(e)
    return {"path": show_path(target), "kind": "text", "chars": len(text), "note": ""}


# ================================================================ 원고

class SceneBody(BaseModel):
    content: str = ""
    from_output: bool = False
    chapter: str | None = None
    after: str | None = None
    new_chapter: bool = False


class SceneMetaBody(BaseModel):
    summary: str | None = None


class SceneMoveBody(BaseModel):
    chapter: str | None = None
    after: str | None = None
    new_chapter: bool = False


class SplitBody(BaseModel):
    at: list[int]


class MergeBody(BaseModel):
    scenes: list[str]


class ChapterBody(BaseModel):
    after: str | None = None


class ChapterMetaBody(BaseModel):
    summary: str | None = None


class ChapterMoveBody(BaseModel):
    after: str | None = None


def _after(body: BaseModel) -> Any:
    """본문에 after가 없으면 '끝', null이면 '맨 앞', 장면 id면 그 뒤."""
    return getattr(body, "after") if "after" in body.model_fields_set else END


@router.post("/manuscript/scenes")
async def add_scene(session_id: str, body: SceneBody, ctx: AppContext = Ctx):
    docs = _docs(ctx, session_id)
    manuscript = docs.manuscript
    text = docs.text(OUTPUT) if body.from_output else body.content
    try:
        # 화면의 '+ 장면'은 빈 장면을 만들고 거기에 직접 쓴다. 출력에서 가져올 때는 빈 것을 받지 않는다.
        scene_id = manuscript.insert(
            text, chapter=body.chapter or None, after=_after(body), new_chapter=body.new_chapter,
            by="user", origin={"from_output": True} if body.from_output else None,
            allow_empty=not body.from_output,
        )
    except DocError as e:
        raise _bad(e)
    if body.from_output:
        docs.clear(OUTPUT, by="user", origin={"moved_to": f"{MANUSCRIPT}/{scene_id}"})
    return {"id": scene_id, "path": f"{MANUSCRIPT}/{scene_id}", "chapter": manuscript.chapter_of(scene_id)}


@router.patch("/manuscript/scenes/{scene}")
async def set_scene(session_id: str, scene: str, body: SceneMetaBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        summary: Any = body.summary if "summary" in body.model_fields_set else END
        manuscript.set_scene(scene, summary=summary)
    except DocError as e:
        raise _bad(e)
    return {"status": "ok"}


@router.post("/manuscript/scenes/{scene}/move")
async def move_scene(session_id: str, scene: str, body: SceneMoveBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        manuscript.move(scene, chapter=body.chapter or None, after=_after(body), new_chapter=body.new_chapter)
    except DocError as e:
        raise _bad(e)
    return {"status": "ok", "chapter": manuscript.chapter_of(scene)}


@router.post("/manuscript/scenes/{scene}/split")
async def split_scene(session_id: str, scene: str, body: SplitBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        ids = manuscript.split(scene, body.at, by="user")
    except DocError as e:
        raise _bad(e)
    return {"ids": ids}


@router.post("/manuscript/merge")
async def merge_scenes(session_id: str, body: MergeBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        return {"id": manuscript.merge(body.scenes, by="user")}
    except DocError as e:
        raise _bad(e)


@router.delete("/manuscript/scenes/{scene}")
async def delete_scene(session_id: str, scene: str, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        manuscript.delete(scene, by="user")
    except DocError as e:
        raise _bad(e)
    return {"status": "ok"}


@router.post("/manuscript/chapters")
async def add_chapter(session_id: str, body: ChapterBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        return {"id": manuscript.add_chapter(body.after)}
    except DocError as e:
        raise _bad(e)


@router.patch("/manuscript/chapters/{chapter}")
async def set_chapter(session_id: str, chapter: str, body: ChapterMetaBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        summary: Any = body.summary if "summary" in body.model_fields_set else END
        manuscript.set_chapter(chapter, summary=summary)
    except DocError as e:
        raise _bad(e)
    return {"status": "ok"}


@router.post("/manuscript/chapters/{chapter}/move")
async def move_chapter(session_id: str, chapter: str, body: ChapterMoveBody, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        manuscript.move_chapter(chapter, body.after)
    except DocError as e:
        raise _bad(e)
    return {"status": "ok"}


@router.delete("/manuscript/chapters/{chapter}")
async def delete_chapter(session_id: str, chapter: str, ctx: AppContext = Ctx):
    manuscript = _docs(ctx, session_id).manuscript
    try:
        manuscript.delete_chapter(chapter)
    except DocError as e:
        raise HTTPException(409 if "장면이 있는" in str(e) else 400, str(e))
    return {"status": "ok"}


# ================================================================ 내보내기

_EXPORTS = {
    "txt": (files.export_txt, "text/plain; charset=utf-8"),
    "md": (files.export_md, "text/markdown; charset=utf-8"),
    "html": (files.export_html, "text/html; charset=utf-8"),
    "zip": (files.export_zip, "application/zip"),
}


@router.get("/export")
async def export(session_id: str, format: str = "md", chapters: bool = True, ctx: AppContext = Ctx):
    """원고를 파일로. chapters=false면 장 번호('1장')를 넣지 않는다 (본문에 직접 적은 사람을 위해)."""
    docs = _docs(ctx, session_id)
    if format not in _EXPORTS:
        raise HTTPException(400, "형식은 txt, md, html, zip 중 하나입니다.")
    title = ctx.sessions.meta(session_id).get("name") or "원고"
    make, media_type = _EXPORTS[format]
    safe = "".join(c for c in title if c not in '\\/:*?"<>|').strip() or "원고"
    return Response(
        make(docs, title, chapters),
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'{safe}.{format}')}"},
    )


# ================================================================ 찾기, 비용

@router.get("/search")
async def search(session_id: str, q: str = "", scope: str = "all", ctx: AppContext = Ctx):
    """사용자가 직접 쓰는 찾기. 원고와 자료에서 글귀가 나오는 곳."""
    docs = _docs(ctx, session_id)
    if scope not in ("all", "manuscript", "materials"):
        raise HTTPException(400, "범위는 all, manuscript, materials 중 하나입니다.")
    hits, truncated = docs.find(q, scope)
    return {"hits": hits, "truncated": truncated}


@router.get("/usage")
async def usage(session_id: str, ctx: AppContext = Ctx):
    """이 작업에서 쓴 토큰과 비용. 단가를 모르는 모델의 호출은 비용에서 빠진다(cost_complete가 false)."""
    _session(ctx, session_id)
    agent = {"prompt_tokens": 0, "output_tokens": 0, "cost_usd": None}
    complete = True
    runs = 0

    def add_cost(holder: dict, use: dict) -> None:
        nonlocal complete
        if use.get("cost_usd") is not None:
            holder["cost_usd"] = (holder["cost_usd"] or 0.0) + float(use["cost_usd"])
        elif use.get("prompt_tokens") or use.get("total_tokens"):
            complete = False

    for e in ctx.sessions.read_events(session_id):
        if e.get("type") != "done":
            continue
        runs += 1
        use = e.get("usage") or {}
        agent["prompt_tokens"] += int(use.get("prompt_tokens") or 0)
        agent["output_tokens"] += int(use.get("output_tokens") or 0)
        add_cost(agent, use)

    tools: dict[str, dict] = {}
    auxiliary = {"calls": 0, "total_tokens": 0, "cost_usd": None}
    for e in ctx.sessions.read_tool_call_log(session_id):
        use = e.get("usage") or {}
        name = str(e.get("tool", ""))
        if name.startswith("["):
            holder = auxiliary
        else:
            holder = tools.setdefault(name, {"tool": name, "label": e.get("label") or name, "calls": 0, "total_tokens": 0, "cost_usd": None})
        holder["calls"] += 1
        holder["total_tokens"] += int(use.get("total_tokens") or 0)
        add_cost(holder, use)

    costs = [agent["cost_usd"], auxiliary["cost_usd"], *(t["cost_usd"] for t in tools.values())]
    known = [c for c in costs if c is not None]
    return {
        "runs": runs,
        "agent": agent,
        "tools": sorted(tools.values(), key=lambda t: -t["calls"]),
        "auxiliary": auxiliary,
        "total_cost_usd": round(sum(known), 6) if known else None,
        "cost_complete": complete,
    }


# ================================================================ 도구 실행 기록

def _tool_runs(ctx: AppContext, session_id: str) -> list[dict]:
    runs = []
    for e in ctx.sessions.read_tool_call_log(session_id):
        if str(e.get("tool", "")).startswith("["):
            continue   # 보조 호출(대화 압축, 읽기 에이전트)
        runs.append({
            "seq": len(runs) + 1,
            **{k: e.get(k) for k in (
                "timestamp", "tool", "label", "by", "model", "duration_ms", "input", "input_raw", "output", "error",
                "tool_call_id", "target",
            )},
            "trial": bool(e.get("trial")),
            "base_seq": e.get("base_seq"),
        })
    return runs


@router.get("/tool-runs")
async def tool_runs(session_id: str, ctx: AppContext = Ctx):
    """이전 입력·출력을 다시 볼 때 쓴다. 최신이 뒤."""
    _session(ctx, session_id)
    return {"runs": _tool_runs(ctx, session_id)}
