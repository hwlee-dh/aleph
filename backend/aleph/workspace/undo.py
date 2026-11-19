"""요청 단위로 되돌리기.

실행이 시작될 때 그 직전의 상태를 한 벌 적어 둔다(last_run.json): 변경 기록의 위치, 원고의
순서·요약, 수정 방지·노트 설정, 에이전트의 대화 기억. 문서의 내용은 따로 적지 않는다.
모든 변경이 변경 기록에 바뀌기 전 버전과 함께 남으므로, 그 실행이 남긴 기록을 거꾸로 밟으면 된다.

가장 최근의 실행만 되돌릴 수 있다. 그 뒤에 사용자가 직접 고친 문서는 건드리지 않는다.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .documents import MANUSCRIPT, Change, DocWorkspace, content_hash, display_name, show_path, zone_of
from .store import MAIN, SessionStore

SNAPSHOT = "last_run.json"


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def _load(session_dir: Path) -> dict | None:
    raw = _read(session_dir / SNAPSHOT)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("run_id") else None


def remember(sessions: SessionStore, session_id: str, *, run_id: str, kind: str, goal: str, conversation: str = MAIN) -> None:
    """실행 직전의 상태를 적어 둔다. 앞선 실행의 것은 덮인다 (가장 최근의 실행만 되돌릴 수 있다)."""
    session_dir = sessions.path(session_id)
    docs = DocWorkspace(session_dir)
    snapshot = {
        "run_id": run_id,
        "kind": kind,
        "goal": goal,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "ledger_seq": docs.ledger_seq(),
        "manuscript": _read(session_dir / "manuscript.json"),
        "workspace": _read(session_dir / "workspace.json"),
        "conversation": conversation,   # 이 실행이 돈 대화. 되돌릴 때 그 대화의 기억을 되돌린다
        "history": _read(sessions.history_path(session_id, conversation)),
        "context_tokens": (sessions.conversation(session_id, conversation) or {}).get("context_tokens", 0),
        "reverted": False,
    }
    (session_dir / SNAPSHOT).write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")


def forget_conversation(sessions: SessionStore, session_id: str, conversation: str) -> None:
    """대화를 지웠다. 마지막 실행이 그 대화의 것이었으면, 되돌릴 때 그 대화의 기억은 되살리지 않는다.

    (첫 대화를 지우면 같은 id의 빈 대화가 새로 생길 수 있다. 거기에 지운 대화의 기억이 들어가면 안 된다.)
    """
    session_dir = sessions.path(session_id)
    snapshot = _load(session_dir)
    if snapshot is None or snapshot["conversation"] != conversation:
        return
    snapshot.update({"conversation_gone": True, "history": None, "context_tokens": 0})
    (session_dir / SNAPSHOT).write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")


def _entries(docs: DocWorkspace, snapshot: dict) -> tuple[list[dict], list[dict]]:
    """(그 실행이 남긴 변경, 그 뒤로 다른 누가 남긴 변경)"""
    mine, others = [], []
    for e in docs.ledger():
        if e["seq"] <= snapshot["ledger_seq"]:
            continue
        (mine if e.get("run_id") == snapshot["run_id"] else others).append(e)
    return mine, others


def _final_paths(entries: list[dict]) -> dict[str, str]:
    """경로마다 그 실행이 마지막으로 한 일. 옮긴 것은 옮겨 간 자리로 센다."""
    out: dict[str, str] = {}
    for e in entries:
        if e["action"] == "move":
            out.pop(e["path"], None)
            out[e["to"]] = "move"
        else:
            out[e["path"]] = e["action"]
    return out


def _touched_later(mine: list[dict], others: list[dict]) -> list[str]:
    """그 실행이 바꾼 문서 가운데, 그 뒤에 다른 누가(사용자가) 손댄 것."""
    paths = {p for e in mine for p in (e["path"], e.get("to")) if p}
    first = {}
    for e in mine:
        for p in (e["path"], e.get("to")):
            if p:
                first.setdefault(p, e["seq"])
    later = []
    for e in others:
        for p in (e["path"], e.get("to")):
            if p and p in paths and e["seq"] > first[p] and p not in later:
                later.append(p)
    return later


def last_run(sessions: SessionStore, session_id: str, *, running: bool) -> dict:
    """가장 최근의 실행과, 그것을 되돌리면 무엇이 달라지는지."""
    session_dir = sessions.path(session_id)
    snapshot = _load(session_dir)
    if snapshot is None:
        return {
            "run_id": None, "conversation_id": None, "kind": None, "goal": "", "status": None, "revertible": False,
            "reason": "되돌릴 기록이 없습니다.", "changes": [], "touched_later": [],
        }
    docs = DocWorkspace(session_dir)
    mine, others = _entries(docs, snapshot)
    titles = _titles(docs, mine)
    changes = [{"path": show_path(p), "action": a, "title": titles(p)} for p, a in _final_paths(mine).items()]
    structure_changed = _shape(snapshot.get("manuscript")) != _shape(_read(session_dir / "manuscript.json"))
    if structure_changed and not any(zone_of(c["path"]) == "manuscript" for c in changes):
        changes.append({"path": MANUSCRIPT, "action": "structure", "title": "원고의 순서"})   # 글은 그대로고 순서만 바뀐 경우
    status = next(
        (e.get("status") for e in reversed(sessions.read_events(session_id))
         if e.get("type") == "done" and e.get("run_id") == snapshot["run_id"]),
        None,
    )
    reason = ""
    if running:
        reason = "실행 중입니다."
    elif snapshot.get("reverted"):
        reason = "이미 되돌렸습니다."
    elif not changes:
        reason = "이 실행이 바꾼 것이 없습니다."
    return {
        "run_id": snapshot["run_id"],
        "conversation_id": snapshot["conversation"],
        "kind": snapshot["kind"],
        "goal": snapshot["goal"],
        "status": status,
        "revertible": not reason,
        "reason": reason,
        "changes": changes,
        "touched_later": [show_path(p) for p in _touched_later(mine, others)],
    }


def _titles(docs: DocWorkspace, entries: list[dict]):
    """경로를 사람이 알아볼 이름으로. 지워져서 지금은 없는 장면은 '지운 장면'이라고 부른다."""

    def title(path: str) -> str:
        shown = show_path(path)
        if zone_of(path) != "manuscript":
            return display_name(path)
        scene_id = shown.split("/", 1)[1]
        try:
            return docs.manuscript.label(scene_id)
        except Exception:
            return "지운 장면"

    return title


def _shape(raw: str | None) -> list:
    """원고의 짜임에서 사람이 정한 것만: 장과 장면의 순서, 직접 쓴 요약. 도구나 에이전트가 붙인 요약은 뺀다.

    그런 요약은 본문을 따라 다시 붙는 것이라서, 그것까지 견주면 요약만 붙인 실행도 원고를 바꾼 것으로 보인다.
    """
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
    return [
        (
            c.get("id"), c.get("summary", "") if c.get("summary_manual") else "",
            [(s.get("id"), s.get("summary", "") if s.get("summary_manual") else "") for s in c.get("scenes", [])],
        )
        for c in (data.get("chapters") or [])
    ]


class RevertError(ValueError):
    def __init__(self, message: str, touched_later: list[str] | None = None):
        super().__init__(message)
        self.touched_later = touched_later or []


def revert(sessions: SessionStore, session_id: str, run_id: str, *, force: bool = False) -> dict:
    """가장 최근의 실행이 바꾼 것을 되돌린다. {"reverted": [...], "kept": [...]}"""
    session_dir = sessions.path(session_id)
    snapshot = _load(session_dir)
    if snapshot is None or snapshot["run_id"] != run_id:
        raise RevertError("가장 최근의 실행만 되돌릴 수 있습니다.")
    if snapshot.get("reverted"):
        raise RevertError("이미 되돌렸습니다.")
    docs = DocWorkspace(session_dir)
    mine, others = _entries(docs, snapshot)
    keep = set(_touched_later(mine, others))
    if keep and not force:
        raise RevertError(
            "이 실행 뒤에 직접 고친 문서가 있습니다. 그 문서들은 그대로 두고 나머지만 되돌릴 수 있습니다.",
            [show_path(p) for p in sorted(keep)],
        )

    origin = {"reverted_run": run_id}
    reverted: list[str] = []
    for e in reversed(mine):
        path, dest = e["path"], e.get("to", "")
        if path in keep or (dest and dest in keep):
            continue
        if e["action"] == "move":
            if docs.exists(dest) and not docs.exists(path):
                docs.apply(Change("move", dest, old=docs.get(dest), dest=path), by="user", origin=origin)
                reverted.append(path)
            continue
        before = docs.version(e["prev_hash"]) if e.get("prev_hash") else None
        current = docs.get(path)
        if before is None:
            if docs.exists(path):                 # 그 실행이 새로 만든 것 → 없앤다
                docs.apply(Change("delete", path, old=current), by="user", origin=origin)
                reverted.append(path)
        elif current != before:                   # 고쳤거나 지운 것 → 그 전의 내용으로
            docs.apply(Change("write", path, content=before, old=current), by="user", origin=origin)
            reverted.append(path)

    _restore_manuscript(docs, snapshot.get("manuscript"))
    _restore_flags(docs, snapshot.get("workspace"))

    conversation = snapshot["conversation"]
    alive = not snapshot.get("conversation_gone") and sessions.conversation(session_id, conversation) is not None
    if alive:   # 그 사이에 지운 대화면 기억은 되돌릴 곳이 없다
        history = sessions.history_path(session_id, conversation)
        if snapshot.get("history") is None:
            history.unlink(missing_ok=True)
        else:
            history.write_text(snapshot["history"], encoding="utf-8")
        sessions.update_conversation(session_id, conversation, context_tokens=snapshot["context_tokens"])

    snapshot["reverted"] = True
    (session_dir / SNAPSHOT).write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    result = {
        "reverted": list(dict.fromkeys(show_path(p) for p in reverted)),
        "kept": [show_path(p) for p in sorted(keep)],
    }
    if alive:
        sessions.append_event(
            session_id, {"type": "reverted", "target_run_id": run_id, "conversation_id": conversation, **result}, conversation
        )
    return result


def _restore_manuscript(docs: DocWorkspace, raw: str | None) -> None:
    """원고의 순서·요약을 실행 전으로. 그 사이에 사용자가 만든 장면은 남기고, 지운 장면은 뺀다."""
    manuscript = docs.manuscript
    current = manuscript._load()
    try:
        before = json.loads(raw) if raw else None
    except ValueError:
        before = None
    if not isinstance(before, dict) or not isinstance(before.get("chapters"), list):
        before = {"next_scene": 1, "next_chapter": 1, "chapters": []}

    def has_file(scene: dict) -> bool:
        return docs.exists(manuscript.path(scene["id"]))

    now = {s["id"]: s for c in current["chapters"] for s in c["scenes"]}
    known: set[str] = set()
    for chapter in before["chapters"]:
        chapter["scenes"] = [s for s in chapter["scenes"] if has_file(s)]
        known.update(s["id"] for s in chapter["scenes"])
        for scene in chapter["scenes"]:
            # 실행 중에 새로 붙은 요약이 지금의 본문과 맞으면 그대로 쓴다 (다시 요약하지 않게)
            fresh = now.get(scene["id"])
            if fresh and not scene.get("summary_manual") and fresh.get("summary") and not fresh.get("summary_manual"):
                if fresh.get("summary_hash") == content_hash(manuscript.content(scene["id"])):
                    scene.update({"summary": fresh["summary"], "summary_hash": fresh["summary_hash"]})
    by_id = {c["id"]: c for c in before["chapters"]}
    for chapter in current["chapters"]:
        extra = [s for s in chapter["scenes"] if s["id"] not in known and has_file(s)]
        if not extra:
            continue
        target = by_id.get(chapter["id"])
        if target is None:                         # 그 사이에 생긴 장에 든 장면이면 장도 같이 남긴다
            target = {**chapter, "scenes": []}
            before["chapters"].append(target)
            by_id[target["id"]] = target
        target["scenes"].extend(extra)
    before["chapters"] = [c for c in before["chapters"] if c["scenes"] or c.get("keep_empty")]
    before["next_scene"] = max(before.get("next_scene", 1), current.get("next_scene", 1))
    before["next_chapter"] = max(before.get("next_chapter", 1), current.get("next_chapter", 1))
    manuscript._save(before)


def _restore_flags(docs: DocWorkspace, raw: str | None) -> None:
    """수정 방지·노트 설정을 실행 전으로 (에이전트가 켠 노트 등)."""
    try:
        before = json.loads(raw) if raw else {}
    except ValueError:
        before = {}
    config = docs._config()
    config["flags"] = before.get("flags") if isinstance(before.get("flags"), dict) else {}
    docs._save_config(config)

