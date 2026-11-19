"""작업(세션) 저장소 — 작업 폴더, 이름과 상태, 대화 기록, 도구 실행 기록.

문서와 원고는 documents.py와 manuscript.py가 다룬다. 여기는 그 밖의 것을 둔다.

    sessions/<id>/
      meta.json           이름, 만든 때, 상태(프리셋, 모드, 권한 무시, 자동 압축, 보고 있는 대화)
      runs.jsonl          실행마다의 설정 (제작 기록용)
      tool_calls.jsonl    도구 실행 기록 (입력과 출력 전문)
      events.jsonl        첫 대화의 기록 (화면이 다시 그릴 때 쓴다)
      history.json        첫 대화에서 에이전트가 기억하는 것
      conversations.json  대화들의 목록 (대화가 하나뿐이면 없을 수 있다)
      conversations/<id>/ 그 뒤에 만든 대화들의 events.jsonl, history.json
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


MAIN = "main"   # 첫 대화의 id
_CONVERSATION_RE = re.compile(r"[a-z0-9]{1,32}")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _append_jsonl(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class SessionStore:
    def __init__(self, base_dir: str | Path):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    # --- 폴더 ---

    @staticmethod
    def valid_id(session_id: str) -> bool:
        return bool(re.fullmatch(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", str(session_id)
        ))

    def path(self, session_id: str) -> Path:
        if not self.valid_id(session_id):
            raise ValueError(f"올바르지 않은 작업 id: {session_id!r}")
        return self.base / str(session_id)

    def exists(self, session_id: str) -> bool:
        return self.valid_id(session_id) and (self.base / session_id / "meta.json").is_file()

    # --- 이름과 상태 ---

    def meta(self, session_id: str) -> dict[str, Any]:
        f = self.path(session_id) / "meta.json"
        if f.exists():
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except (json.JSONDecodeError, OSError):
                pass
        return {}

    def save_meta(self, session_id: str, meta: dict[str, Any]) -> None:
        f = self.path(session_id) / "meta.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def update_meta(self, session_id: str, **values: Any) -> dict[str, Any]:
        meta = self.meta(session_id)
        meta.update(values)
        self.save_meta(session_id, meta)
        return meta

    def create_session(self, name: str) -> dict[str, Any]:
        session_id = str(uuid4())
        created_at = datetime.now().isoformat(timespec="seconds")
        self.save_meta(session_id, {"name": name, "created_at": created_at})
        return {"id": session_id, "name": name, "created_at": created_at}

    def rename_session(self, session_id: str, name: str) -> None:
        self.update_meta(session_id, name=name)

    def delete_session(self, session_id: str) -> bool:
        d = self.path(session_id)
        if not d.is_dir():
            return False
        shutil.rmtree(d)
        return True

    def list_sessions(self) -> list[dict[str, Any]]:
        sessions = []
        for d in self.base.iterdir():
            if not self.exists(d.name):
                continue
            meta = self.meta(d.name)
            sessions.append({
                "id": d.name,
                "name": meta.get("name", d.name[:8]),
                "created_at": meta.get("created_at"),
                "updated_at": self._updated_at(d) or meta.get("created_at"),
                "preset_id": meta.get("preset_id", ""),
            })
        sessions.sort(key=lambda s: s.get("created_at") or "", reverse=True)
        return sessions

    @staticmethod
    def _updated_at(session_dir: Path) -> str | None:
        """문서나 원고의 순서가 마지막으로 바뀐 때. 변경 기록과 원고 색인 파일이 고쳐진 때로 안다."""
        times = [f.stat().st_mtime for f in (session_dir / "ledger.jsonl", session_dir / "manuscript.json") if f.is_file()]
        return datetime.fromtimestamp(max(times)).isoformat(timespec="seconds") if times else None

    # --- 대화 ---
    #
    # 작업 하나에 대화가 여럿 있을 수 있다. 문서와 원고는 작업의 것이고 대화들이 같이 쓴다.
    # 대화마다 따로 있는 것은 화면 기록(events.jsonl)과 에이전트의 기억(history.json)이다.
    # 첫 대화(`main`)의 파일은 작업 폴더에 그대로 있고, 그 뒤의 대화는 conversations/<id>/에 있다.

    def valid_conversation(self, conversation: str) -> bool:
        return bool(_CONVERSATION_RE.fullmatch(str(conversation)))

    def conversation_dir(self, session_id: str, conversation: str = MAIN) -> Path:
        base = self.path(session_id)
        if conversation in ("", MAIN):
            return base
        if not self.valid_conversation(conversation):
            raise ValueError(f"올바르지 않은 대화 id: {conversation!r}")
        return base / "conversations" / conversation

    def history_path(self, session_id: str, conversation: str = MAIN) -> Path:
        return self.conversation_dir(session_id, conversation) / "history.json"

    def _conversation_index(self, session_id: str) -> list[dict]:
        f = self.path(session_id) / "conversations.json"
        try:
            items = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            items = None
        if isinstance(items, list):
            items = [i for i in items if isinstance(i, dict) and self.valid_conversation(str(i.get("id", "")))]
        if not items:   # 대화가 하나뿐인 작업, 또는 대화를 다 지운 작업
            items = [{"id": MAIN, "name": "", "created_at": self.meta(session_id).get("created_at")}]
        return items

    def _save_conversation_index(self, session_id: str, items: list[dict]) -> None:
        f = self.path(session_id) / "conversations.json"
        f.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    def conversations(self, session_id: str) -> list[dict]:
        """이 작업의 대화들, 만든 순서대로. {id, name, created_at, updated_at, context_tokens}"""
        out = []
        for item in self._conversation_index(session_id):
            events = self.conversation_dir(session_id, item["id"]) / "events.jsonl"
            updated = datetime.fromtimestamp(events.stat().st_mtime).isoformat(timespec="seconds") if events.is_file() else None
            out.append({
                "id": item["id"],
                "name": str(item.get("name") or ""),
                "created_at": item.get("created_at"),
                "updated_at": updated or item.get("created_at"),
                "context_tokens": int(item.get("context_tokens") or 0),
            })
        return out

    def conversation(self, session_id: str, conversation: str) -> dict | None:
        return next((c for c in self.conversations(session_id) if c["id"] == conversation), None)

    def create_conversation(self, session_id: str, name: str = "") -> dict:
        items = self._conversation_index(session_id)
        taken = {i["id"] for i in items}
        new_id = uuid4().hex[:8]
        while new_id in taken:
            new_id = uuid4().hex[:8]
        items.append({"id": new_id, "name": name.strip(), "created_at": datetime.now().isoformat(timespec="seconds")})
        self._save_conversation_index(session_id, items)
        self.conversation_dir(session_id, new_id).mkdir(parents=True, exist_ok=True)
        return self.conversation(session_id, new_id)   # type: ignore[return-value]

    def update_conversation(self, session_id: str, conversation: str, **values: Any) -> dict | None:
        """대화의 이름이나 컨텍스트 크기를 적는다. 없는 대화면 None."""
        items = self._conversation_index(session_id)
        item = next((i for i in items if i["id"] == conversation), None)
        if item is None:
            return None
        item.update({k: v for k, v in values.items() if k in ("name", "context_tokens")})
        self._save_conversation_index(session_id, items)
        return self.conversation(session_id, conversation)

    def delete_conversation(self, session_id: str, conversation: str) -> bool:
        """대화의 기록과 기억을 지운다. 문서와 원고는 그대로다. 마지막 대화를 지우면 빈 대화 하나가 남는다."""
        items = self._conversation_index(session_id)
        if not any(i["id"] == conversation for i in items):
            return False
        folder = self.conversation_dir(session_id, conversation)
        if conversation == MAIN:
            for f in [folder / "events.jsonl", folder / "history.json", *folder.glob("history-*.json")]:
                f.unlink(missing_ok=True)
        elif folder.is_dir():
            shutil.rmtree(folder)
        self._save_conversation_index(session_id, [i for i in items if i["id"] != conversation])
        return True

    # --- 대화 기록 ---

    def append_event(self, session_id: str, event: dict, conversation: str = MAIN) -> None:
        entry = {"timestamp": datetime.now().isoformat(timespec="milliseconds"), **event}
        _append_jsonl(self.conversation_dir(session_id, conversation) / "events.jsonl", entry)

    def read_events(self, session_id: str, conversation: str | None = None) -> list[dict]:
        """대화 하나의 기록. conversation을 안 주면 이 작업의 모든 대화를 시간 순서로 합친 것 (비용, 제작 기록에 쓴다)."""
        if conversation is not None:
            return _read_jsonl(self.conversation_dir(session_id, conversation) / "events.jsonl")
        ids = [i["id"] for i in self._conversation_index(session_id)]
        if len(ids) == 1:
            return _read_jsonl(self.conversation_dir(session_id, ids[0]) / "events.jsonl")
        merged = [e for cid in ids for e in _read_jsonl(self.conversation_dir(session_id, cid) / "events.jsonl")]
        return sorted(merged, key=lambda e: str(e.get("timestamp") or ""))   # 같은 때의 것은 읽은 순서 그대로

    # --- 도구 실행 기록 (입력과 출력 전문) ---

    def append_tool_call_log(self, session_id: str, entry: dict) -> None:
        _append_jsonl(self.path(session_id) / "tool_calls.jsonl", entry)

    def read_tool_call_log(self, session_id: str) -> list[dict]:
        return _read_jsonl(self.path(session_id) / "tool_calls.jsonl")

    # --- 실행마다의 설정 ---
    #
    # events.jsonl은 화면이 대화를 그리려고 읽으므로, 실행별 설정(지침 전문, 모드, 모델, 도구의
    # 지시문)은 따로 적는다. 제작 기록(process_log)이 "어떤 설정이 이 글을 만들었나"를 엮을 때 쓴다.

    def append_run(self, session_id: str, manifest: dict) -> None:
        entry = {"timestamp": datetime.now().isoformat(timespec="milliseconds"), **manifest}
        _append_jsonl(self.path(session_id) / "runs.jsonl", entry)

    def read_runs(self, session_id: str) -> list[dict]:
        return _read_jsonl(self.path(session_id) / "runs.jsonl")
