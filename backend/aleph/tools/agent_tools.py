"""에이전트의 기본 도구 — 작업 공간을 읽고 쓴다.

파일을 고치는 도구는 전부 `async def`다. 동기 함수는 라이브러리가 다른 스레드에서 돌리므로, 모델이 한 응답에
같은 도구를 여러 번 부르면 같은 파일(원고의 색인 등)을 동시에 읽고 써서 서로의 변경을 잃는다.
async 함수는 한 스레드에서 차례로 돌고, 읽고 쓰는 사이에 기다리는 곳이 없으면 끼어들지 못한다.

막힌 변경인지, 사용자 확인이 필요한지는 `RunDeps`가 판단한다. 여기서는 "하려고 했다"까지만 한다.
긴 글을 장면으로 나눌 때 에이전트는 자를 자리만 정하고, 실제로 자르는 것은 엔진이 한다.
"""

from __future__ import annotations

import asyncio
import functools
import mimetypes
import time

from pydantic import BaseModel, Field
from pydantic_ai import RunContext, Tool
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import BinaryContent, ToolReturn

from ..agent.deps import APPROVE, REJECT, RunDeps
from ..workspace.documents import (
    INPUT,
    MANUSCRIPT,
    OUTPUT,
    DocError,
    content_hash,
    display_name,
    josa,
    kind_of,
    normalize_path,
    show_path,
    zone_of,
)
from ..workspace.manuscript import END, cut_text, find_cuts
from .definitions import find_tool
from .runtime import run_tool_on

Ctx = RunContext[RunDeps]
VIEW_LIMIT = 20 * 1024 * 1024   # 모델에 그대로 보낼 파일의 크기 한도


class Cut(BaseModel):
    before: str = Field(description="새 장면이 시작되는 자리의 글귀. 원문에 있는 그대로, 한 곳만 가리키도록 충분히 길게 적는다.")
    new_chapter: bool = Field(default=False, description="이 자리에서 새 장이 시작되면 true")


def _head(text: str, limit: int = 60) -> str:
    line = text.strip().split("\n", 1)[0]
    return line[:limit] + ("…" if len(line) > limit else "")


# ------------------------------------------------------------------ 읽기

def list_docs(ctx: Ctx, path: str = "") -> str:
    """작업 공간의 목록을 봅니다.

    Args:
        path: 볼 곳. 비우면 전체(입력·출력의 상태, 자료 목록, 원고의 장면 목록). '자료', '자료/인물', '원고', '원고/2장'처럼 적습니다.

    Returns:
        목록. 원고는 장면마다 번호, 경로, 글자 수, 요약이 한 줄씩 나옵니다.
    """
    return ctx.deps.docs.read(path)


def read(ctx: Ctx, path: str, start_line: int = 0, end_line: int = 0) -> str:
    """문서 하나를 읽습니다. '입력', '출력', '자료/…', '원고/s3'(장면)을 읽을 수 있습니다.

    기억에 의존하지 말고, 판단하기 전에 지금 적혀 있는 것을 읽으세요. 사용자가 직접 고쳤을 수 있습니다.
    긴 문서는 한 번에 일부만 돌아옵니다. 안내에 따라 start_line을 주어 이어서 읽으세요.

    Args:
        path: 문서 경로. 확장자는 생략합니다.
        start_line: 읽기 시작할 줄 (1부터). 비우면 처음부터.
        end_line: 읽기를 끝낼 줄. 비우면 끝까지(길면 중간에서 끊깁니다).

    Returns:
        문서의 내용
    """
    return ctx.deps.docs.read(path, start_line, end_line)


def view_file(ctx: Ctx, path: str) -> ToolReturn | str:
    """자료에 있는 이미지나 PDF를 직접 봅니다.

    글 문서는 read로 읽으세요. 이것은 글로 읽을 수 없는 파일(삽화, 스캔한 문서)을 볼 때 씁니다.
    본 내용 가운데 남겨 둘 것은 자료에 글로 적어 두세요. 파일의 내용은 이번 요청이 끝나면 대화 기억에서 빠집니다.

    Args:
        path: 파일 경로 ('자료/삽화/등대.png', '자료/올린 글/스캔.pdf')

    Returns:
        파일의 내용 (이미지나 PDF가 그대로 전달됩니다)
    """
    docs = ctx.deps.docs
    try:
        target = normalize_path(path)
    except DocError as e:
        return f"오류: {e}"
    if zone_of(target) != "material" or not docs.exists(target):
        return f"오류: '{path}' 파일이 없습니다. 자료에 있는 파일만 볼 수 있습니다."
    if kind_of(target) == "text":
        return "오류: 글 문서입니다. 글 문서는 read로 읽습니다."
    data = docs.get_bytes(target) or b""
    if len(data) > VIEW_LIMIT:
        return f"오류: 파일이 너무 큽니다 ({len(data) // (1024 * 1024)}MB). {VIEW_LIMIT // (1024 * 1024)}MB까지 볼 수 있습니다."
    media_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
    return ToolReturn(
        return_value=f"'{show_path(target)}' 파일을 아래에 첨부했습니다.",
        content=[f"[{show_path(target)}]", BinaryContent(data=data, media_type=media_type)],
    )


def search(ctx: Ctx, query: str, path: str = "") -> str:
    """작업 공간에서 글귀를 찾습니다. 어느 문서 몇째 줄에 나오는지 돌려줍니다.

    Args:
        query: 찾을 말
        path: 찾을 범위('자료/인물', '원고' 등). 비우면 전체.

    Returns:
        찾은 위치 목록
    """
    return ctx.deps.docs.search(query, path)


# ------------------------------------------------------------------ 쓰기 (입력, 출력, 자료, 장면 본문)

async def _delete_scene(ctx: Ctx, target: str, confirm: bool) -> str:
    deps = ctx.deps
    manuscript = deps.docs.manuscript
    scene_id = show_path(target).split("/", 1)[1]
    label = manuscript.label(scene_id)
    payload = {
        "action": "delete", "path": show_path(target), "dest": None,
        "old": manuscript.content(scene_id), "new": None, "description": f"원고에서 지우기: {label}",
    }
    refusal, extra = await deps.guard(zone="manuscript", paths=[target], payload=payload, confirm=confirm)
    if refusal:
        return refusal
    manuscript.delete(scene_id, by="agent", run_id=deps.run_id, origin={"tool_call_id": ctx.tool_call_id or "", **extra})
    deps.note_manuscript_changed(scene_id)
    return f"{label}{josa(label, '을', '를')} 원고에서 지웠습니다." + (" 사용자가 승인했습니다." if extra else "")


async def write(ctx: Ctx, path: str, content: str, confirm: bool = False) -> str:
    """문서를 새로 쓰거나 통째로 바꿉니다.

    쓸 수 있는 곳: '입력'(도구에 넘길 글), '출력', '자료/…'(없는 폴더는 자동으로 생깁니다), '원고/s3'(있는 장면의 본문).
    새 장면은 이것으로 만들지 않고 insert_scene을 씁니다. 일부만 고칠 때는 edit을 쓰세요.
    통째로 다시 쓰면 사용자가 고친 부분을 덮어쓸 수 있습니다.

    Args:
        path: 문서 경로
        content: 문서 전체 내용
        confirm: true면 바꾸기 전에 사용자에게 보여 주고 확인을 받습니다.

    Returns:
        결과. 사용자가 반려했으면 그 사유.
    """
    deps = ctx.deps
    try:
        change = deps.docs.plan_write(path, content)
    except DocError as e:
        return f"오류: {e}"
    _, message = await deps.change_doc(change, origin={"tool_call_id": ctx.tool_call_id or ""}, confirm=confirm)
    return message


async def edit(ctx: Ctx, path: str, old_text: str, new_text: str, confirm: bool = False) -> str:
    """문서의 한 부분만 고칩니다.

    old_text와 정확히 일치하는 부분을 new_text로 바꿉니다. 일치하는 곳이 없거나 여러 곳이면 오류를 돌려주니,
    주변 글을 더 포함해 한 곳만 가리키게 하세요.

    Args:
        path: 문서 경로 ('입력', '출력', '자료/…', '원고/s3')
        old_text: 바꿀 기존 글 (정확히 일치해야 함)
        new_text: 새로 넣을 글
        confirm: true면 바꾸기 전에 사용자에게 보여 주고 확인을 받습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    try:
        change = deps.docs.plan_edit(path, old_text, new_text)
    except DocError as e:
        return f"오류: {e}"
    _, message = await deps.change_doc(change, origin={"tool_call_id": ctx.tool_call_id or ""}, confirm=confirm)
    return message


async def delete(ctx: Ctx, path: str, confirm: bool = False) -> str:
    """자료 문서나 원고의 장면을 지웁니다. 지운 내용은 버전 기록에 남아 사용자가 복원할 수 있습니다.

    Args:
        path: 지울 문서 ('자료/…' 또는 '원고/s3')
        confirm: true면 지우기 전에 사용자 확인을 받습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    try:
        target = deps.docs.resolve(path)
        if zone_of(target) == "manuscript":
            if deps.docs.is_folder(target):
                return "오류: 장이나 원고 전체는 지울 수 없습니다. 장면은 하나씩 지울 수 있습니다."
            return await _delete_scene(ctx, target, confirm)
        change = deps.docs.plan_delete(path)
    except DocError as e:
        return f"오류: {e}"
    _, message = await deps.change_doc(change, origin={"tool_call_id": ctx.tool_call_id or ""}, confirm=confirm)
    return message


async def move(ctx: Ctx, source: str, destination: str, confirm: bool = False) -> str:
    """자료 문서를 옮기거나 이름을 바꿉니다. '출력'을 자료로 옮겨 보관할 때도 씁니다 (출력은 비워집니다).

    원고의 장면은 이것으로 옮기지 않습니다. insert_scene, move_scene을 쓰세요.

    Args:
        source: 지금 경로 ('자료/…' 또는 '출력')
        destination: 옮길 경로 ('자료/…')
        confirm: true면 옮기기 전에 사용자 확인을 받습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    try:
        change = deps.docs.plan_move(source, destination)
    except DocError as e:
        return f"오류: {e}"
    _, message = await deps.change_doc(change, origin={"tool_call_id": ctx.tool_call_id or ""}, confirm=confirm)
    return message


async def replace_all(ctx: Ctx, query: str, replacement: str, path: str = "", confirm: bool = False) -> str:
    """여러 문서에서 같은 글귀를 한 번에 바꿉니다. 인물 이름을 바꾸는 것처럼 기계적인 수정에 씁니다.

    query와 정확히 같은 글귀를 전부 replacement로 바꿉니다 (대소문자, 띄어쓰기까지 같아야 합니다).
    다른 낱말의 일부까지 바뀔 수 있으니, 먼저 search로 어디에 나오는지 확인하세요.
    수정 방지가 걸린 문서는 건너뜁니다.

    Args:
        query: 찾을 글귀
        replacement: 바꿀 글귀. 비우면 그 글귀를 지웁니다.
        path: 범위. 비우면 원고와 자료 전체. '원고', '원고/2장', '자료/인물', 문서 하나도 됩니다.
        confirm: true면 바꾸기 전에 사용자 확인을 받습니다.

    Returns:
        결과. 문서마다 몇 곳을 바꿨는지.
    """
    deps = ctx.deps
    docs = deps.docs
    if not query:
        return "오류: 찾을 글귀가 비어 있습니다."
    if query == replacement:
        return "오류: 찾을 글귀와 바꿀 글귀가 같습니다."
    try:
        targets = docs.text_paths(path)
    except DocError as e:
        return f"오류: {e}"
    found = [(p, docs.get(p) or "") for p in targets]
    found = [(p, text) for p, text in found if query in text]
    if not found:
        return f"'{query}'{josa(query, '이', '가')} 나오는 곳이 없습니다."
    skipped = [p for p, _ in found if not deps.bypass_locks and docs.locked(p)]
    todo = [(p, text) for p, text in found if p not in skipped]
    if deps.mode == "plan":
        todo = [(p, text) for p, text in todo if zone_of(p) == "material"]
    if not todo:
        return "오류: 바꿀 수 있는 문서가 없습니다. " + (
            "계획 모드에서는 자료만 고칠 수 있습니다." if deps.mode == "plan" else "전부 수정 방지가 걸려 있습니다."
        )

    def title(p: str) -> str:
        return docs.manuscript.label(show_path(p).split("/", 1)[1]) if zone_of(p) == "manuscript" else display_name(p)

    def samples(text: str) -> list[dict]:
        lines = [line.strip() for line in text.split("\n") if query in line][:2]
        return [{"before": line[:160], "after": line.replace(query, replacement)[:160]} for line in lines]

    total = sum(text.count(query) for _, text in todo)
    zone = "manuscript" if any(zone_of(p) == "manuscript" for p, _ in todo) else "material"
    payload = {
        "action": "replace", "path": show_path(docs.resolve(path)) if path.strip() else "", "dest": None, "old": None, "new": None,
        "query": query, "replacement": replacement,
        "items": [
            {"path": show_path(p), "title": title(p), "count": text.count(query), "samples": samples(text)}
            for p, text in todo
        ],
        "description": f"찾아 바꾸기: '{query}' → '{replacement}' (문서 {len(todo)}개, {total}곳)",
    }
    refusal, extra = await deps.guard(zone=zone, paths=[], payload=payload, confirm=confirm)
    if refusal:
        return refusal
    origin = {"tool_call_id": ctx.tool_call_id or "", "replaced": [query, replacement], **extra}
    scenes: list[str] = []
    for p, text in todo:
        docs.apply(docs.plan_write(p, text.replace(query, replacement)), by="agent", run_id=deps.run_id, origin=origin)
        if zone_of(p) == "manuscript":
            scenes.append(show_path(p).split("/", 1)[1])
        else:
            deps.changed.append(show_path(p))
    if scenes:
        deps.note_manuscript_changed(*scenes)
    parts = ", ".join(f"{title(p)} {text.count(query)}곳" for p, text in todo)
    message = f"문서 {len(todo)}개에서 {total}곳을 바꿨습니다: {parts}."
    if skipped:
        message += f" 수정 방지가 걸려 건너뛴 것: {', '.join(title(p) for p in skipped)}."
    return message + (" 사용자가 승인했습니다." if extra else "")


async def set_note(ctx: Ctx, path: str, on: bool = True) -> str:
    """자료 문서나 폴더의 노트 옵션을 켜거나 끕니다.

    노트로 지정한 자료는 매 요청마다 자동으로 읽힙니다. 지금의 계획이나 합의한 방향처럼 계속 기억해야 하는
    짧은 문서에만 켜고, 더는 매번 볼 필요가 없으면 끄세요. 긴 문서를 노트로 두면 요청마다 그만큼 읽게 됩니다.

    Args:
        path: 자료 문서나 폴더 ('자료/계획')
        on: true면 켜고 false면 끕니다.

    Returns:
        결과
    """
    docs = ctx.deps.docs
    try:
        target = docs.resolve(path)
        if zone_of(target) != "material":
            return "오류: 노트는 자료에만 지정할 수 있습니다."
        if not docs.exists(target) and not docs.is_folder(target):
            return f"오류: '{path}' 문서가 없습니다."
        docs.set_flag(target, "note", bool(on))
    except DocError as e:
        return f"오류: {e}"
    ctx.deps.changed.append(show_path(target))
    return f"'{show_path(target)}'의 노트를 {'켰습니다. 다음 요청부터 자동으로 읽힙니다' if on else '껐습니다'}."


# ------------------------------------------------------------------ 원고

def _position(deps: RunDeps, chapter: int, after: str, at_start: bool):
    """에이전트가 적은 자리를 (장 id, after) 로."""
    manuscript = deps.docs.manuscript
    chapter_id = manuscript.chapter_id(chapter) if chapter else None
    if after.strip():
        return chapter_id, manuscript.scene_id(after)
    return chapter_id, (None if at_start else END)


def _position_words(deps: RunDeps, chapter_id: str | None, after, new_chapter: bool) -> str:
    manuscript = deps.docs.manuscript
    if after not in (None, END):
        where = f"{manuscript.label(after)} 뒤"
    elif chapter_id:
        number = manuscript.resolve(chapter_id)
        index = [c["id"] for c in manuscript.overview()["chapters"]].index(number.split("/", 1)[1]) + 1
        where = f"{index}장의 {'맨 앞' if after is None else '끝'}"
    else:
        where = "원고의 끝" if after is END else "마지막 장의 맨 앞"
    return f"{where}{' (새 장으로)' if new_chapter else ''}"


async def insert_scene(
    ctx: Ctx,
    content: str = "",
    from_output: bool = False,
    from_doc: str = "",
    chapter: int = 0,
    after: str = "",
    at_start: bool = False,
    new_chapter: bool = False,
    replace: str = "",
    confirm: bool = False,
) -> str:
    """원고에 장면을 넣습니다. 있는 장면의 본문을 통째로 바꿀 때도 씁니다.

    도구가 쓴 글을 원고에 올릴 때는 from_output=true로 부릅니다. 긴 글을 다시 적지 않고 출력에서 그대로 가져가고,
    출력은 비워집니다. 자료에 보관해 둔 초고를 올릴 때는 from_doc에 그 문서를 적습니다 (그 문서는 원고로 옮겨져 자료에서 없어집니다).
    자리를 정하지 않으면 원고의 맨 끝에 들어갑니다.

    Args:
        content: 장면의 본문. from_output이나 from_doc을 쓰면 비워 둡니다.
        from_output: true면 본문을 '출력'에서 가져옵니다.
        from_doc: 본문을 가져올 자료 문서 ('자료/초고/아침'). 올린 뒤 그 문서는 없어집니다.
        chapter: 넣을 장의 번호 (1부터). 비우면 마지막 장.
        after: 이 장면 뒤에 넣습니다 ('원고/s3' 또는 's3'). 비우면 장의 끝.
        at_start: true면 장의 맨 앞에 넣습니다.
        new_chapter: true면 새 장을 만들어 거기 넣습니다.
        replace: 새로 넣지 않고 이 장면의 본문을 바꿉니다 ('원고/s3').
        confirm: true면 넣기 전에 사용자 확인을 받습니다.

    Returns:
        결과. 넣은 장면의 경로가 들어 있습니다.
    """
    deps = ctx.deps
    docs = deps.docs
    manuscript = docs.manuscript
    source = ""
    if from_doc.strip():
        try:
            source = docs.resolve(from_doc)
        except DocError as e:
            return f"오류: {e}"
        if zone_of(source) != "material" or docs.get(source) is None:
            return f"오류: '{from_doc}'{josa(from_doc, '은', '는')} 자료의 글 문서가 아닙니다."
        reason = deps.blocked("material", [source])
        if reason:
            return f"오류: {reason}"
        text = docs.get(source) or ""
        from_output = False
    else:
        text = docs.text(OUTPUT) if from_output else content
    if not text.strip():
        return "오류: 넣을 글이 비어 있습니다." + (" 출력이 비어 있습니다." if from_output else "")
    origin = {"tool_call_id": ctx.tool_call_id or "", **({"from_output": True} if from_output else {})}
    if source:
        origin["from_doc"] = show_path(source)

    def consume(scene_id: str) -> str:
        """가져온 곳을 비운다. 덧붙일 말을 돌려준다."""
        moved = {"moved_to": f"{MANUSCRIPT}/{scene_id}"}
        if from_output:
            docs.clear(OUTPUT, by="agent", run_id=deps.run_id, origin=moved)
            deps.changed.append(OUTPUT)
            return " 출력은 비웠습니다."
        if source:
            docs.apply(docs.plan_delete(source), by="agent", run_id=deps.run_id, origin=moved)
            deps.changed.append(show_path(source))
            return f" '{show_path(source)}'{josa(source, '은', '는')} 원고로 옮겨졌습니다."
        return ""

    try:
        if replace.strip():
            scene_id = manuscript.scene_id(replace)
            change = docs.plan_write(manuscript.path(scene_id), text.strip("\n"))
            ok, message = await deps.change_doc(change, origin=origin, confirm=confirm)
            if ok:
                consume(scene_id)
            return message

        chapter_id, where = _position(deps, chapter, after, at_start)
        words = _position_words(deps, chapter_id, where, new_chapter)
        lock_path = f"{MANUSCRIPT}/{chapter_id or (manuscript.chapter_of(where) if where not in (None, END) else '')}".rstrip("/")
        payload = {
            "action": "insert", "path": MANUSCRIPT, "dest": None, "old": None, "new": text.strip("\n"),
            "position": {"chapter": chapter_id, "after": None if where is END else where, "end": where is END, "new_chapter": new_chapter},
            "description": f"원고에 장면 넣기: {words}",
        }
        refusal, extra = await deps.guard(zone="manuscript", paths=[lock_path], payload=payload, confirm=confirm)
        if refusal:
            return refusal
        scene_id = manuscript.insert(
            text, chapter=chapter_id, after=where, new_chapter=new_chapter,
            by="agent", run_id=deps.run_id, origin={**origin, **extra},
        )
    except DocError as e:
        return f"오류: {e}"
    tail = consume(scene_id)
    deps.note_manuscript_changed(scene_id)
    return (
        f"원고에 장면을 넣었습니다: {manuscript.label(scene_id)} — 경로 '{MANUSCRIPT}/{scene_id}' ({len(text.strip()):,}자). "
        "요약은 아직 없습니다."
        + tail
        + (" 사용자가 승인했습니다." if extra else "")
    )


async def move_scene(
    ctx: Ctx, scene: str, chapter: int = 0, after: str = "", at_start: bool = False, new_chapter: bool = False,
    confirm: bool = False,
) -> str:
    """원고에서 장면의 자리를 옮깁니다. 본문은 그대로입니다.

    Args:
        scene: 옮길 장면 ('원고/s3')
        chapter: 옮겨 갈 장의 번호. 비우면 마지막 장.
        after: 이 장면 뒤로 옮깁니다. 비우면 장의 끝.
        at_start: true면 장의 맨 앞으로.
        new_chapter: true면 새 장을 만들어 거기로 옮깁니다.
        confirm: true면 옮기기 전에 사용자 확인을 받습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    manuscript = deps.docs.manuscript
    try:
        scene_id = manuscript.scene_id(scene)
        chapter_id, where = _position(deps, chapter, after, at_start)
        label = manuscript.label(scene_id)
        words = _position_words(deps, chapter_id, where, new_chapter)
        payload = {
            "action": "reorder", "path": f"{MANUSCRIPT}/{scene_id}", "dest": None, "old": None, "new": None,
            "position": {"chapter": chapter_id, "after": None if where is END else where, "end": where is END, "new_chapter": new_chapter},
            "description": f"장면 옮기기: {label} → {words}",
        }
        refusal, extra = await deps.guard(
            zone="manuscript", paths=[manuscript.path(scene_id)], payload=payload, confirm=confirm
        )
        if refusal:
            return refusal
        manuscript.move(scene_id, chapter=chapter_id, after=where, new_chapter=new_chapter)
    except DocError as e:
        return f"오류: {e}"
    deps.note_manuscript_changed(scene_id)
    return f"장면을 옮겼습니다: 이제 {manuscript.label(scene_id)}입니다." + (" 사용자가 승인했습니다." if extra else "")


async def split(ctx: Ctx, path: str, cuts: list[Cut], confirm: bool = False) -> str:
    """긴 글을 장면들로 나눕니다. 어디서 자를지만 정하면, 자르는 것은 시스템이 합니다 (글은 한 글자도 바뀌지 않습니다).

    path가 원고의 장면이면 그 장면이 여러 장면으로 나뉩니다.
    path가 자료 문서면(사용자가 올린 긴 글 등) 그 글을 잘라 원고의 끝에 장면들로 넣습니다. 자료 문서는 그대로 남습니다.
    글을 다시 적지 마세요. 먼저 read로 구간을 나눠 읽으며 장면이 바뀌는 자리를 찾고, 그 자리의 글귀를 cuts에 적습니다.

    Args:
        path: 나눌 글 ('원고/s3' 또는 '자료/…')
        cuts: 자를 자리들. 원문의 순서대로 적습니다. 자리마다 그 글귀 앞에서 잘립니다.
        confirm: true면 나누기 전에 사용자 확인을 받습니다.

    Returns:
        결과. 만들어진 장면들의 경로가 들어 있습니다.
    """
    deps = ctx.deps
    docs = deps.docs
    manuscript = docs.manuscript
    try:
        target = docs.resolve(path)
        if docs.is_folder(target):
            return "오류: 폴더나 장은 나눌 수 없습니다. 문서나 장면 하나를 적어야 합니다."
        text = docs.get(target)
        if text is None:
            return f"오류: '{path}' 문서가 없습니다."
        in_manuscript = zone_of(target) == "manuscript"
        if not in_manuscript and zone_of(target) != "material":
            return f"오류: '{INPUT}'과 '{OUTPUT}'은 나눌 수 없습니다. 자료로 옮기면 나눌 수 있습니다."
        offsets = find_cuts(text, [c.before for c in cuts])
        pieces = cut_text(text, offsets)
        if len(pieces) < 2:
            return "오류: 자를 자리가 없습니다."
        # cuts의 n번째(0부터)가 pieces의 n+1번째 조각을 연다. (원문 맨 앞을 가리킨 자리는 조각 0을 연다)
        shift = 0 if offsets and offsets[0] == 0 else 1
        fresh = {i + shift for i, c in enumerate(cuts) if c.new_chapter}
        payload = {
            "action": "split", "path": show_path(target), "dest": None, "old": None, "new": None,
            "pieces": [
                {"chars": len(p), "head": _head(p), "new_chapter": n in fresh}
                for n, p in enumerate(pieces)
            ],
            "description": (
                f"장면 나누기: {manuscript.label(show_path(target).split('/', 1)[1])} → {len(pieces)}개"
                if in_manuscript
                else f"'{show_path(target)}'{josa(target, '을', '를')} 장면 {len(pieces)}개로 나눠 원고에 넣기"
            ),
        }
        lock_paths = [target] if in_manuscript else [MANUSCRIPT]
        refusal, extra = await deps.guard(zone="manuscript", paths=lock_paths, payload=payload, confirm=confirm)
        if refusal:
            return refusal
        origin = {"tool_call_id": ctx.tool_call_id or "", **extra}
        if in_manuscript:
            ids = manuscript.split(
                show_path(target).split("/", 1)[1], offsets, new_chapter_at=fresh,
                by="agent", run_id=deps.run_id, origin=origin,
            )
        else:
            ids = manuscript.import_text(
                text, offsets, new_chapter_at=fresh,
                by="agent", run_id=deps.run_id, origin={**origin, "imported_from": show_path(target)},
            )
    except DocError as e:
        return f"오류: {e}"
    deps.note_manuscript_changed(*ids)
    listing = ", ".join(f"{MANUSCRIPT}/{i}" for i in ids)
    return f"장면 {len(ids)}개로 나눴습니다: {listing}. 요약은 아직 없습니다." + (" 사용자가 승인했습니다." if extra else "")


async def merge_scenes(ctx: Ctx, scenes: list[str], confirm: bool = False) -> str:
    """장면들을 하나로 합칩니다. 적은 순서대로 이어 붙여 첫 장면에 담고, 나머지 장면은 없어집니다.

    Args:
        scenes: 합칠 장면들 ('원고/s3', '원고/s4' …). 둘 이상.
        confirm: true면 합치기 전에 사용자 확인을 받습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    manuscript = deps.docs.manuscript
    try:
        ids = list(dict.fromkeys(manuscript.scene_id(s) for s in scenes))
        if len(ids) < 2:
            return "오류: 합칠 장면을 둘 이상 적어야 합니다."
        labels = [manuscript.label(i) for i in ids]
        merged = "\n\n".join(t for t in (manuscript.content(i).strip() for i in ids) if t)
        payload = {
            "action": "merge", "path": f"{MANUSCRIPT}/{ids[0]}", "dest": None,
            "old": manuscript.content(ids[0]), "new": merged, "scenes": [f"{MANUSCRIPT}/{i}" for i in ids],
            "description": f"장면 합치기: {', '.join(labels)}",
        }
        refusal, extra = await deps.guard(
            zone="manuscript", paths=[manuscript.path(i) for i in ids], payload=payload, confirm=confirm
        )
        if refusal:
            return refusal
        first = manuscript.merge(ids, by="agent", run_id=deps.run_id, origin={"tool_call_id": ctx.tool_call_id or "", **extra})
    except DocError as e:
        return f"오류: {e}"
    deps.note_manuscript_changed(*ids)
    return f"장면 {len(ids)}개를 합쳤습니다: {manuscript.label(first)} — 경로 '{MANUSCRIPT}/{first}'." + (
        " 사용자가 승인했습니다." if extra else ""
    )


# ------------------------------------------------------------------ 요약

SUMMARY_INPUT_LIMIT = 40_000   # 요약에 넘기는 장면의 글. 이보다 길면 앞부분만 넘긴다
SUMMARY_PARALLEL = 4


def _summary_target(deps: RunDeps, ref: str) -> tuple[str, str]:
    """('scene' | 'chapter', id). 장면이나 장이 아니면 DocError."""
    manuscript = deps.docs.manuscript
    raw = str(ref or "").strip().strip("/")
    if raw.startswith(f"{MANUSCRIPT}/"):
        raw = raw.split("/", 1)[1]
    name = manuscript.resolve(raw).split("/", 1)[1]
    return ("chapter", name) if name.startswith("c") else ("scene", name[:-3])


def _chapter_label(deps: RunDeps, chapter_id: str) -> str:
    ids = [c["id"] for c in deps.docs.manuscript.overview()["chapters"]]
    return f"{ids.index(chapter_id) + 1}장" if chapter_id in ids else chapter_id


async def set_summary(ctx: Ctx, target: str, summary: str = "", from_output: bool = False, overwrite: bool = False) -> str:
    """장면이나 장에 요약을 붙입니다. 원고 목록에서 그 자리의 머리로 보이는 글입니다.

    장면을 넣거나 고친 뒤에 씁니다. 요약 도구를 돌렸으면 from_output=true로 출력에 있는 글을 그대로 붙이고,
    방금 읽거나 쓴 장면이라 내용을 알면 summary에 직접 적어도 됩니다. 본문은 바뀌지 않습니다.
    장면이 여럿이면 summarize_scenes가 한 번에 합니다.

    Args:
        target: 장면이나 장 ('원고/s3', '원고/c2', '2장')
        summary: 요약. 한두 문장으로, 무슨 일이 일어나고 무엇이 달라지는지를 적습니다.
        from_output: true면 summary 대신 출력에 있는 글을 붙입니다. 출력은 그대로 둡니다.
        overwrite: 사용자가 직접 쓴 요약은 사용자가 시켰을 때만 true로 덮습니다.

    Returns:
        결과
    """
    deps = ctx.deps
    manuscript = deps.docs.manuscript
    if deps.mode == "plan":
        return f"오류: {deps.blocked('manuscript', [])}"
    text = (deps.docs.text(OUTPUT) if from_output else summary).strip()
    if not text:
        return "오류: 붙일 요약이 비어 있습니다." + (" 출력이 비어 있습니다." if from_output else "")
    try:
        kind, name = _summary_target(deps, target)
    except DocError as e:
        return f"오류: {e}"
    data = manuscript._load()
    item = manuscript._chapter(data, name) if kind == "chapter" else (lambda c, i: c["scenes"][i])(*manuscript._locate(data, name))
    if item.get("summary_manual") and not overwrite:
        return "사용자가 직접 쓴 요약이 있어 그대로 두었습니다. 사용자가 바꾸라고 했으면 overwrite=true로 다시 부르세요."
    if item.get("summary_manual"):
        (manuscript.set_chapter if kind == "chapter" else manuscript.set_scene)(name, summary=None)
    if kind == "chapter":
        manuscript.set_chapter_summary(name, text, manuscript.chapter_basis(name)[1])
        deps.note_manuscript_changed()
        return f"{_chapter_label(deps, name)}에 요약을 붙였습니다."
    manuscript.set_summary(name, text, content_hash(manuscript.content(name)))
    deps.note_manuscript_changed(name)
    return f"{manuscript.label(name)}에 요약을 붙였습니다."


async def summarize_scenes(ctx: Ctx, targets: list[str] | None = None, tool: str = "") -> str:
    """도구 하나를 장면 여러 개에 한꺼번에 돌려서, 나온 글을 각 장면의 요약으로 붙입니다.

    장면마다 따로 돌고 입력과 출력은 건드리지 않습니다. 긴 글을 장면으로 나눈 뒤나, 요약이 없거나 낡은 장면이
    여럿일 때 씁니다. 장면 하나라면 요약 도구를 보통 도구처럼 돌리고 set_summary로 붙여도 됩니다.
    사용자가 직접 쓴 요약은 덮지 않습니다.

    Args:
        targets: 요약할 장면과 장 ('원고/s3', '원고/c2'). 비우면 요약이 없거나 낡은 장면 전부.
            장을 적으면 그 장의 장면 요약들을 재료로 장의 요약을 만듭니다 (장면 요약이 다 있어야 합니다).
        tool: 돌릴 도구의 이름. 비우면 '요약' 도구.

    Returns:
        결과. 요약이 붙은 곳과 실패한 곳.
    """
    deps = ctx.deps
    manuscript = deps.docs.manuscript
    if deps.mode == "plan":
        return f"오류: {deps.blocked('output', [])}"
    usable = [t for t in deps.tools if t.enabled and t.name and t.prompt.strip()]
    chosen = find_tool(usable, tool) if tool.strip() else (find_tool(usable, "summarize") or find_tool(usable, "요약"))
    if chosen is None:
        if tool.strip():
            return f"오류: '{tool}' 도구가 없습니다."
        return "오류: 요약 도구가 없습니다. 요약은 set_summary로 직접 붙일 수 있습니다."

    scenes: list[str] = []
    chapters: list[str] = []
    try:
        if targets:
            for ref in targets:
                kind, name = _summary_target(deps, ref)
                (chapters if kind == "chapter" else scenes).append(name)
        else:
            scenes = manuscript.stale()
    except DocError as e:
        return f"오류: {e}"
    scenes, chapters = list(dict.fromkeys(scenes)), list(dict.fromkeys(chapters))
    if not scenes and not chapters:
        return "요약할 장면이 없습니다. 요약이 없거나 낡은 장면이 없습니다."

    if deps.mode == "manual":
        names = [manuscript.label(i) for i in scenes] + [_chapter_label(deps, c) for c in chapters]
        answer = (
            await deps.hitl.ask(
                f"'{chosen.title}' 도구를 {len(names)}곳에 돌려 요약을 붙이려 합니다.",
                [APPROVE, REJECT],
                kind="tool_confirm",
                extra={"tool": chosen.name, "label": chosen.title, "input": "\n".join(names)},
            )
        ).strip()
        if answer != APPROVE:
            deps.rejected = True
            note = "" if answer == REJECT else answer
            return f"사용자가 반려했습니다{f' — {note}' if note else ''}. 요약을 붙이지 않았습니다."

    call_id = ctx.tool_call_id or ""
    gate = asyncio.Semaphore(SUMMARY_PARALLEL)
    done: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []
    data = manuscript._load()

    async def one_scene(scene_id: str) -> None:
        label = manuscript.label(scene_id)
        chapter, index = manuscript._locate(data, scene_id)
        if chapter["scenes"][index].get("summary_manual"):
            skipped.append(f"{label}(사용자가 쓴 요약)")
            return
        content = manuscript.content(scene_id)
        if not content.strip():
            skipped.append(f"{label}(빈 장면)")
            return
        piece = content[:SUMMARY_INPUT_LIMIT]
        too_long = deps.over_input_limit(piece)
        if too_long:
            failed.append(f"{label}: {too_long}")
            return
        async with gate:
            text, error = await run_tool_on(
                chosen, deps, piece, target=f"{MANUSCRIPT}/{scene_id}", tool_call_id=call_id
            )
        if error:
            failed.append(f"{label}: {error}")
            return
        manuscript.set_summary(scene_id, text, content_hash(content))
        done.append(label)

    await asyncio.gather(*(one_scene(i) for i in scenes))

    for chapter_id in chapters:   # 장은 장면 요약이 다 붙은 뒤에
        label = _chapter_label(deps, chapter_id)
        if manuscript._chapter(manuscript._load(), chapter_id).get("summary_manual"):
            skipped.append(f"{label}(사용자가 쓴 요약)")
            continue
        material, basis = manuscript.chapter_basis(chapter_id)
        if not material:
            failed.append(f"{label}: 요약이 없는 장면이 있어 장의 요약을 만들 수 없습니다")
            continue
        text, error = await run_tool_on(
            chosen, deps, f"[{label}의 장면 요약들]\n{material}", target=f"{MANUSCRIPT}/{chapter_id}", tool_call_id=call_id
        )
        if error:
            failed.append(f"{label}: {error}")
            continue
        manuscript.set_chapter_summary(chapter_id, text, basis)
        done.append(label)

    if done:
        deps.note_manuscript_changed(*scenes)
    parts = [f"'{chosen.title}' 도구로 {len(done)}곳에 요약을 붙였습니다." if done else "요약을 붙인 곳이 없습니다."]
    if skipped:
        parts.append(f"건너뛴 곳: {', '.join(skipped)}.")
    if failed:
        parts.append(f"실패한 곳 {len(failed)}곳 — {'; '.join(failed[:5])}{' 외' if len(failed) > 5 else ''}.")
    return " ".join(parts)


# ------------------------------------------------------------------ 읽기 에이전트

EXPLORE_RESULT_LIMIT = 12_000   # 읽기 에이전트의 답이 이보다 길면 앞부분만 돌려준다
EXPLORE_MAX_STEPS = 100         # 읽기 에이전트가 모델을 부르는 횟수의 끝 (헛돌 때를 막는 값. 보통은 몇 번에 끝난다)

EXPLORE_INSTRUCTION = """당신은 창작 작업 공간의 글을 대신 읽어 주는 읽기 에이전트입니다.
본 에이전트가 맡긴 일을 하고, 그 결과만 글로 돌려줍니다. 본 에이전트는 당신이 읽은 글을 보지 못하고 당신의 답만 봅니다.

작업 공간에는 입력, 출력, 자료(자료/…), 원고(원고/…)가 있습니다. 원고는 장 아래 장면으로 나뉘고, 목록에는 장면마다 요약이 한 줄씩 붙어 있습니다.
- list로 목록을 보고, read로 문서나 장면을 읽고, search로 글귀를 찾습니다. 고칠 수는 없습니다.
- 목록의 요약으로 볼 곳을 좁힌 뒤 필요한 것만 읽습니다. 요약이 없거나 낡았다고 적힌 장면은 요약을 믿지 말고 읽습니다.
- 확인하지 않은 것을 짐작으로 적지 않습니다.

답은 이렇게 씁니다.
- 맡은 일에 대한 답을 먼저 적습니다.
- 근거가 된 곳을 경로로 적습니다 (원고/s3, 자료/인물/서윤). 꼭 필요하면 그 대목을 짧게 인용합니다. 본문을 길게 옮겨 적지 않습니다.
- 찾지 못했거나 확인하지 못한 것은 그렇다고 적습니다.
군더더기 없이 사실만 씁니다."""


async def explore(ctx: Ctx, task: str) -> str:
    """읽기 에이전트를 내보내 원고와 자료를 대신 읽게 하고, 결론만 돌려받습니다.

    여러 장면이나 긴 자료를 훑어야 답할 수 있는 일에 씁니다: 이 인물이 앞에서 어떻게 그려졌는지,
    설정이 어긋나는 곳이 있는지, 어떤 일이 어느 장면에서 일어났는지, 긴 자료에서 필요한 대목이 어디인지.
    읽기 에이전트가 읽은 글은 이 대화에 쌓이지 않습니다. 직접 다 읽는 것보다 훨씬 가볍습니다.
    읽기 에이전트는 이 대화를 보지 못합니다. 무엇을 알아봐야 하는지, 어디를 보면 되는지, 답을 어떤 꼴로 원하는지를 task에 다 적으세요.
    고칠 대목을 직접 봐야 할 때는 그 장면만 read로 읽으세요.

    Args:
        task: 알아볼 일. 그것만 읽고도 일할 수 있게 적습니다.

    Returns:
        읽기 에이전트의 답 (근거가 된 경로와 함께)
    """
    deps = ctx.deps
    if not task.strip():
        return "오류: 알아볼 일이 비어 있습니다."
    call_id = ctx.tool_call_id or ""
    trail: list[str] = []   # 읽기 에이전트가 본 것. 기록에 남긴다 (본 에이전트에게는 돌려주지 않는다)

    def stream(delta: str) -> None:
        deps.emit({"type": "tool_stream", "tool": "explore", "tool_call_id": call_id, "delta": delta})

    def watched(fn, label: str, key: str):
        """읽기 에이전트가 도구를 부를 때마다 무엇을 보는지 화면에 한 줄 흘려보낸다."""
        @functools.wraps(fn)
        async def run(inner: Ctx, *args, **kwargs):
            what = kwargs.get(key) or (args[0] if args else "")
            trail.append(f"{label}: {what or '전체'}")
            stream(f"{label}: {what or '전체'}\n")
            return fn(inner, *args, **kwargs)

        return run

    tools = [
        Tool(watched(list_docs, "목록 보기", "path"), name="list", takes_ctx=True),
        Tool(watched(read, "읽기", "path"), name="read", takes_ctx=True),
        Tool(watched(search, "찾기", "query"), name="search", takes_ctx=True),
    ]
    prompt = f"<task>\n{task.strip()}\n</task>\n\n<workspace>\n지금의 목록입니다.\n\n{deps.docs.overview()}\n</workspace>"
    started = time.monotonic()
    try:
        text, usage = await deps.llm.complete(
            deps.auxiliary_model,
            system=EXPLORE_INSTRUCTION,
            prompt=prompt,
            temperature=deps.auxiliary_temperature,
            max_tokens=deps.auxiliary_max_output_tokens,
            thinking=deps.auxiliary_thinking,
            tools=tools,
            deps=deps,
            max_steps=EXPLORE_MAX_STEPS,
            on_delta=stream,
        )
    except UsageLimitExceeded:
        deps.note_trail(call_id, trail)
        return f"오류: 읽기 에이전트가 모델을 {EXPLORE_MAX_STEPS}번 부르고도 끝내지 못해 멈췄습니다. 일을 더 좁혀야 합니다."
    except Exception as e:
        from ..agent.loop import friendly_error

        return f"오류: 읽기 에이전트를 돌리지 못했습니다. {friendly_error(e)}"
    deps.note_trail(call_id, trail)
    deps.log_aux_call("explore", usage, started, tool_call_id=call_id, task=task.strip(), trail=trail, output=text)
    if not text.strip():
        return "(읽기 에이전트가 빈 답을 돌려주었습니다.)"
    if len(text) > EXPLORE_RESULT_LIMIT:
        return text[:EXPLORE_RESULT_LIMIT].rstrip() + f"\n\n(답이 길어 앞부분만 보입니다. 전체 {len(text):,}자)"
    return text


# ------------------------------------------------------------------ 이미지 만들기

IMAGE_REFERENCES = 3   # 같이 보일 수 있는 그림의 수
_IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


async def generate_image(ctx: Ctx, prompt: str, name: str = "", references: list[str] | None = None) -> str:
    """이미지 모델에게 그림을 한 장 만들게 하고 자료/삽화에 저장합니다.

    이미지 모델은 이 대화를 보지 못합니다. 무엇을 어떤 구도와 화풍으로 그릴지 prompt에 다 적으세요
    (누가, 어디서, 무엇을 하는지, 시점과 빛, 그림의 방식). 원고의 문장을 그대로 옮기지 말고 그림으로 풀어 적습니다.
    인물의 생김새나 화풍을 앞의 그림과 맞추려면 그 그림을 references에 적습니다.
    만든 그림을 원고에 넣으려면 그 자리에 ![설명](경로)라고 적습니다.

    Args:
        prompt: 그릴 것. 이미지 모델이 이것만 보고 그립니다.
        name: 저장할 이름 ('등탑의 밤'). 비우면 '만든 그림'. 같은 이름이 있으면 번호가 붙습니다.
        references: 같이 보일 그림들의 경로 ('자료/삽화/서윤.png'). 셋까지.

    Returns:
        저장된 경로
    """
    deps = ctx.deps
    docs = deps.docs
    if not deps.image_model:
        return "오류: 이미지 모델이 정해지지 않았습니다."
    if deps.mode == "plan":
        return f"오류: {deps.blocked('output', [])}"
    if not prompt.strip():
        return "오류: 그릴 것이 비어 있습니다."
    shown: list[tuple[bytes, str]] = []
    try:
        for ref in (references or [])[:IMAGE_REFERENCES]:
            target = normalize_path(ref)
            data = docs.get_bytes(target) if zone_of(target) == "material" and kind_of(target) == "image" else None
            if not data:
                return f"오류: '{ref}'{josa(ref, '은', '는')} 자료에 있는 그림이 아닙니다."
            shown.append((data, mimetypes.guess_type(target)[0] or "image/png"))
        stem = normalize_path(f"자료/삽화/{name.strip() or '만든 그림'}.png")[:-len(".png")]
    except DocError as e:
        return f"오류: {e}"

    if deps.mode == "manual":
        answer = (
            await deps.hitl.ask(
                "이미지를 만들려 합니다.", [APPROVE, REJECT], kind="tool_confirm",
                extra={"tool": "generate_image", "label": "이미지 만들기", "input": prompt.strip()},
            )
        ).strip()
        if answer != APPROVE:
            deps.rejected = True
            note = "" if answer == REJECT else answer
            return f"사용자가 반려했습니다{f' — {note}' if note else ''}. 이미지를 만들지 않았습니다."

    started = time.monotonic()
    call_id = ctx.tool_call_id or ""
    try:
        made, said, usage = await deps.llm.image(deps.image_model, prompt=prompt.strip(), references=shown)
    except Exception as e:
        from ..agent.loop import friendly_error

        deps.log_aux_call("image", None, started, model=deps.image_model, tool_call_id=call_id, task=prompt.strip(), error=f"{type(e).__name__}: {e}")
        if "Image output is not supported" in str(e):
            return f"오류: '{deps.image_model}'{josa(deps.image_model, '은', '는')} 그림을 만드는 모델이 아닙니다."
        return f"오류: 이미지를 만들지 못했습니다. {friendly_error(e)}"
    if made is None:
        deps.log_aux_call("image", usage, started, model=deps.image_model, tool_call_id=call_id, task=prompt.strip(), output=said)
        return "이미지 모델이 그림을 내지 않았습니다." + (f" 모델의 말: {said[:600]}" if said else "")
    data, kind = made
    saved = docs.save_file(f"{stem}{_IMAGE_EXT.get(kind, '.png')}", data, by="agent")
    deps.changed.append(show_path(saved))
    deps.log_aux_call("image", usage, started, model=deps.image_model, tool_call_id=call_id, task=prompt.strip(), output=show_path(saved))
    return f"이미지를 '{show_path(saved)}'에 저장했습니다. 원고에 넣으려면 그 자리에 ![설명]({show_path(saved)})라고 적습니다."


# ------------------------------------------------------------------ 사용자에게 묻기

async def ask_user(ctx: Ctx, question: str, options: list[str] | None = None) -> str:
    """사용자에게 질문하거나 선택지를 제시합니다.

    판단이 갈리는 지점에서 씁니다. 사용자가 답할 때까지 기다리고, 답이 반환값으로 돌아옵니다.

    Args:
        question: 사용자에게 보여줄 질문
        options: 선택지. 생략하면 자유롭게 답합니다.

    Returns:
        사용자의 답
    """
    return await ctx.deps.hitl.ask(question, options)


READ_TOOLS: dict[str, tuple] = {
    "list": (list_docs, "목록 보기"),
    "read": (read, "읽기"),
    "search": (search, "찾기"),
    "explore": (explore, "읽기 에이전트"),
    "view_file": (view_file, "파일 보기"),
}
WRITE_TOOLS: dict[str, tuple] = {
    "write": (write, "쓰기"),
    "edit": (edit, "부분 수정"),
    "delete": (delete, "지우기"),
    "move": (move, "옮기기"),
    "replace_all": (replace_all, "찾아 바꾸기"),
    "set_note": (set_note, "노트 지정"),
}
MANUSCRIPT_TOOLS: dict[str, tuple] = {
    "insert_scene": (insert_scene, "원고에 넣기"),
    "move_scene": (move_scene, "장면 옮기기"),
    "split": (split, "장면으로 나누기"),
    "merge_scenes": (merge_scenes, "장면 합치기"),
    "set_summary": (set_summary, "요약 붙이기"),
    "summarize_scenes": (summarize_scenes, "묶음 요약"),
}
ASK_TOOL = "ask_user"
IMAGE_TOOL = "generate_image"


def agent_tool_catalog() -> list[dict]:
    """화면이 실행 기록에 이름을 보일 때 쓰는 목록."""
    items = [
        {"name": name, "label": label}
        for group in (READ_TOOLS, WRITE_TOOLS, MANUSCRIPT_TOOLS)
        for name, (_, label) in group.items()
    ]
    items.append({"name": IMAGE_TOOL, "label": "이미지 만들기"})
    items.append({"name": ASK_TOOL, "label": "사용자에게 묻기"})
    return items


def build_agent_tools(mode: str, image: bool = False) -> list[Tool]:
    """모드에 맞는 기본 도구. 계획 모드에서는 원고 도구를 주지 않고, 자율 모드에서는 묻기 도구를 주지 않는다.

    image: 프리셋에 이미지 모델이 정해져 있으면 그림을 만드는 도구를 준다 (계획 모드에서는 주지 않는다).
    """
    groups = [READ_TOOLS, WRITE_TOOLS] + ([] if mode == "plan" else [MANUSCRIPT_TOOLS])
    tools = [Tool(fn, name=name, takes_ctx=True) for group in groups for name, (fn, _) in group.items()]
    if image and mode != "plan":
        tools.append(Tool(generate_image, name=IMAGE_TOOL, takes_ctx=True))
    if mode != "autonomous":
        tools.append(Tool(ask_user, name=ASK_TOOL, takes_ctx=True))
    return tools
