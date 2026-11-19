"""원고 — 장 아래 장면, 그리고 그 순서·요약.

장면의 본문은 문서(원고/<장면 id>.md)로 있고, 여기서는 그 문서들을 어떤 순서로
어느 장에 묶을지와 장면마다의 요약을 관리한다. 장과 장면에 제목은 없다 (필요하면 본문에 글로 적는다). 순서는 이름과 무관하다.
번호는 위치에서 나오고, 장면 id(s1, s2 …)와 장 id(c1, c2 …)는 한번 정해지면 바뀌지 않는다.

에이전트는 원고 전체를 읽지 않고 장면 요약 목록을 들고 있다가 필요한 장면만 읽는다.
그래서 요약이 본문과 어긋나지 않게 하는 것이 중요하다: 요약에는 어떤 본문을 보고
썼는지(summary_hash)가 같이 남고, 본문이 달라지면 '낡은 요약'으로 표시된다.

긴 글을 장면으로 나눌 때 자르는 것은 여기서 한다. 에이전트는 어디서 자를지만 정한다.
조각을 이어 붙이면 원문과 같다 (조각 앞뒤의 빈 줄만 걷어 낸다).
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .documents import MANUSCRIPT, Change, DocError, content_hash, josa, trim_blank_edges, write_whole

if TYPE_CHECKING:
    from .documents import DocWorkspace

END: Any = object()   # '장의 맨 끝'을 뜻하는 표시 (after=None은 '맨 앞')


def find_cuts(text: str, anchors: list[str]) -> list[int]:
    """자를 자리들. anchor마다 그 글귀가 시작하는 위치를 찾는다. 원문에 한 곳만 있어야 하고 순서대로여야 한다."""
    offsets: list[int] = []
    floor = 0
    for n, anchor in enumerate(anchors, start=1):
        needle = anchor.strip()
        if not needle:
            raise DocError(f"{n}번째 자를 자리가 비어 있습니다.")
        count = text.count(needle)
        if count == 0:
            raise DocError(f"{n}번째 자를 자리를 원문에서 찾을 수 없습니다: '{needle[:40]}'. 원문의 글귀를 그대로 적어야 합니다.")
        if count > 1:
            raise DocError(f"{n}번째 자를 자리가 원문에 {count}곳 있습니다: '{needle[:40]}'. 더 길게 적어 한 곳만 가리켜야 합니다.")
        at = text.index(needle)
        if at <= floor and not (n == 1 and at == 0):
            raise DocError(f"{n}번째 자를 자리가 앞의 것보다 뒤에 있지 않습니다. 원문의 순서대로 적어야 합니다.")
        offsets.append(at)
        floor = at
    return offsets


def cut_text(text: str, offsets: list[int]) -> list[str]:
    """offsets에서 잘라 조각으로 나눈다. 조각 앞뒤의 빈 줄만 걷어 낸다. 빈 조각이 나오면 오류."""
    points = sorted({o for o in offsets if 0 < o < len(text)})
    pieces = [trim_blank_edges(text[a:b]) for a, b in zip([0, *points], [*points, len(text)])]
    if any(not p.strip() for p in pieces):
        raise DocError("자른 조각 가운데 빈 것이 있습니다. 자를 자리를 다시 정해야 합니다.")
    return pieces


class Manuscript:
    def __init__(self, docs: "DocWorkspace"):
        self.docs = docs
        self.file = docs.dir / "manuscript.json"

    # ------------------------------------------------------------- 저장

    def _load(self) -> dict:
        if self.file.exists():
            try:
                data = json.loads(self.file.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("chapters"), list):
                    return data
            except ValueError:
                pass
        return {"next_scene": 1, "next_chapter": 1, "chapters": []}

    def _save(self, data: dict) -> None:
        write_whole(self.file, json.dumps(data, ensure_ascii=False, indent=2))

    @staticmethod
    def path(scene_id: str) -> str:
        return f"{MANUSCRIPT}/{scene_id}.md"

    @staticmethod
    def _new_chapter(data: dict) -> dict:
        chapter = {"id": f"c{data['next_chapter']}", "summary": "", "summary_hash": "", "scenes": []}
        data["next_chapter"] += 1
        return chapter

    @staticmethod
    def _new_scene(data: dict) -> dict:
        scene = {"id": f"s{data['next_scene']}", "summary": "", "summary_hash": "", "summary_manual": False}
        data["next_scene"] += 1
        return scene

    # ------------------------------------------------------------- 찾기

    def resolve(self, rest: str) -> str:
        """'원고/' 뒤에 적힌 것을 실제 경로로. s3 · c2 · 2장 · 1.2(1장 둘째 장면)를 받는다."""
        ref = rest.strip().strip("/")
        if ref.endswith(".md"):
            ref = ref[:-3]
        data = self._load()
        chapters = data["chapters"]
        if re.fullmatch(r"s\d+", ref):
            if any(s["id"] == ref for c in chapters for s in c["scenes"]):
                return self.path(ref)
        elif re.fullmatch(r"c\d+", ref):
            if any(c["id"] == ref for c in chapters):
                return f"{MANUSCRIPT}/{ref}"
        elif m := re.fullmatch(r"(\d+)\s*장?", ref):
            n = int(m.group(1))
            if 1 <= n <= len(chapters):
                return f"{MANUSCRIPT}/{chapters[n - 1]['id']}"
        elif m := re.fullmatch(r"(\d+)[.\-](\d+)", ref):
            c, s = int(m.group(1)), int(m.group(2))
            if 1 <= c <= len(chapters) and 1 <= s <= len(chapters[c - 1]["scenes"]):
                return self.path(chapters[c - 1]["scenes"][s - 1]["id"])
        raise DocError(f"원고에 '{rest}'{josa(rest, '이라는', '라는')} 장이나 장면이 없습니다. list('{MANUSCRIPT}')로 목록을 볼 수 있습니다.")

    def scene_id(self, ref: str) -> str:
        """에이전트나 화면이 적은 장면 표시(s3, 원고/s3, 1.2)를 장면 id로."""
        raw = str(ref or "").strip().strip("/")
        if raw.startswith(f"{MANUSCRIPT}/"):
            raw = raw.split("/", 1)[1]
        path = self.resolve(raw)
        name = path.split("/", 1)[1]
        if not name.startswith("s"):
            raise DocError(f"'{ref}'{josa(str(ref), '은', '는')} 장면이 아닙니다.")
        return name[:-3]

    def chapter_id(self, ref: str | int | None) -> str | None:
        """장 표시(c2, 2, '2장', 원고/2장)를 장 id로. 비어 있으면 None."""
        if ref in (None, "", 0):
            return None
        raw = str(ref).strip().strip("/")
        if raw.startswith(f"{MANUSCRIPT}/"):
            raw = raw.split("/", 1)[1]
        path = self.resolve(raw)
        name = path.split("/", 1)[1]
        if not name.startswith("c"):
            raise DocError(f"'{ref}'{josa(str(ref), '은', '는')} 장이 아닙니다.")
        return name

    def chapter_of(self, scene_id: str) -> str | None:
        for c in self._load()["chapters"]:
            if any(s["id"] == scene_id for s in c["scenes"]):
                return c["id"]
        return None

    @staticmethod
    def _locate(data: dict, scene_id: str) -> tuple[dict, int]:
        for c in data["chapters"]:
            for i, s in enumerate(c["scenes"]):
                if s["id"] == scene_id:
                    return c, i
        raise DocError(f"원고에 '{scene_id}' 장면이 없습니다.")

    @staticmethod
    def _chapter(data: dict, chapter_id: str) -> dict:
        for c in data["chapters"]:
            if c["id"] == chapter_id:
                return c
        raise DocError(f"원고에 '{chapter_id}' 장이 없습니다.")

    def scene_ids(self, only: str | None = None) -> list[str]:
        return [s["id"] for c in self._load()["chapters"] if only in (None, c["id"]) for s in c["scenes"]]

    def scene_paths(self, only: str | None = None) -> list[str]:
        return [self.path(i) for i in self.scene_ids(only)]

    def content(self, scene_id: str) -> str:
        return self.docs.get(self.path(scene_id)) or ""

    def text(self, only: str | None = None) -> str:
        """원고(또는 장 하나)의 본문을 순서대로 이어 붙인다."""
        blocks = [self.content(i).strip() for i in self.scene_ids(only)]
        return "\n\n".join(b for b in blocks if b)

    def label(self, scene_id: str) -> str:
        """사람에게 보일 장면 이름: '1장 2번째 장면'."""
        data = self._load()
        chapter, index = self._locate(data, scene_id)
        number = data["chapters"].index(chapter) + 1
        return f"{number}장 {index + 1}번째 장면"

    # ------------------------------------------------------------- 보여주기

    @staticmethod
    def _summary_state(scene: dict, content: str) -> str:
        if scene.get("summary_manual"):
            return "manual"
        if not scene.get("summary"):
            return "none"
        return "ok" if scene.get("summary_hash") == content_hash(content) else "stale"

    def overview(self) -> dict:
        """화면이 그릴 원고의 구조."""
        docs = self.docs
        flags = docs.flags()
        last = docs._last_writers()
        chapters = []
        total = 0
        for n, c in enumerate(self._load()["chapters"], start=1):
            scenes = []
            for i, s in enumerate(c["scenes"], start=1):
                path = self.path(s["id"])
                content = docs.get(path) or ""
                f = docs.root / path
                total += len(content)
                scenes.append({
                    "id": s["id"],
                    "path": f"{MANUSCRIPT}/{s['id']}",
                    "number": i,
                    "summary": s.get("summary", ""),
                    "summary_state": self._summary_state(s, content),
                    "head": next((line.strip() for line in content.splitlines() if line.strip()), "")[:80],   # 요약이 아직 없을 때 대신 보일 첫 줄
                    "chars": len(content),
                    "locked": docs.effective(path, "locked", flags),
                    "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds") if f.is_file() else None,
                    "by": last.get(path, ""),
                })
            chapters.append({
                "id": c["id"],
                "number": n,
                "summary": c.get("summary", ""),
                "locked": docs.effective(f"{MANUSCRIPT}/{c['id']}", "locked", flags),
                "scenes": scenes,
            })
        return {"chars": total, "locked": docs.effective(MANUSCRIPT, "locked", flags), "chapters": chapters}

    def listing(self, only: str | None = None, *, limit: int | None = None, collapse: bool = True) -> str:
        """에이전트에게 보여줄 원고 목록 — 장면마다 한 줄, 요약과 함께.

        limit를 넘게 길어지면 가장 최근에 손댄 장만 펼치고 나머지는 장 요약 한 줄로 접는다.
        """
        data = self._load()
        docs = self.docs
        if not any(c["scenes"] for c in data["chapters"]) and not data["chapters"]:
            return "(원고 비어 있음)"
        flags = docs.flags()

        def scene_line(n: int, i: int, s: dict) -> tuple[str, int, float]:
            path = self.path(s["id"])
            content = docs.get(path) or ""
            f = docs.root / path
            state = self._summary_state(s, content)
            summary = s.get("summary") or "(요약 없음)"
            if state == "stale":
                summary += " (본문이 바뀐 뒤 요약을 고치지 않음)"
            lock = " [수정 방지]" if docs.effective(path, "locked", flags) else ""
            line = f"  {n}.{i} {MANUSCRIPT}/{s['id']} {len(content):,}자{lock} — {summary}"
            return line, len(content), f.stat().st_mtime if f.is_file() else 0.0

        blocks: list[dict] = []
        for n, c in enumerate(data["chapters"], start=1):
            if only is not None and c["id"] != only:
                continue
            lines, chars, newest = [], 0, 0.0
            for i, s in enumerate(c["scenes"], start=1):
                line, size, mtime = scene_line(n, i, s)
                lines.append(line)
                chars += size
                newest = max(newest, mtime)
            blocks.append({"head": f"{n}장 [{c['id']}]", "lines": lines, "chars": chars, "newest": newest, "chapter": c, "n": n})

        total_scenes = sum(len(b["lines"]) for b in blocks)
        total_chars = sum(b["chars"] for b in blocks)
        header = f"{len(blocks)}장 {total_scenes}장면 {total_chars:,}자" if only is None else ""

        def render(expanded: set[str] | None) -> str:
            out = [header] if header else []
            for b in blocks:
                c = b["chapter"]
                if expanded is None or c["id"] in expanded:
                    out.append(b["head"] + (" (장면 없음)" if not b["lines"] else ""))
                    out.extend(b["lines"])
                else:
                    summary = c.get("summary") or "(장 요약 없음)"
                    out.append(
                        f"{b['head']} — 장면 {len(b['lines'])}개, {b['chars']:,}자. {summary} "
                        f"(list('{MANUSCRIPT}/{b['n']}장')으로 펼쳐 보기)"
                    )
            return "\n".join(out)

        full = render(None)
        if not collapse or limit is None or len(full) <= limit or len(blocks) <= 1:
            return full
        latest = max(blocks, key=lambda b: b["newest"])
        return render({latest["chapter"]["id"]})

    # ------------------------------------------------------------- 장면 넣기·옮기기

    def _place(self, data: dict, scene: dict, chapter: str | None, after: Any, new_chapter: bool) -> dict:
        """장면을 넣을 자리를 정해 그 자리에 끼운다. 들어간 장을 돌려준다."""
        chapters = data["chapters"]
        if after not in (None, END):
            target, index = self._locate(data, str(after))
            if new_chapter:
                # 그 장면 뒤에서 장을 가른다: 뒤따르던 장면들도 새 장으로 간다.
                fresh = self._new_chapter(data)
                fresh["scenes"] = [scene, *target["scenes"][index + 1:]]
                del target["scenes"][index + 1:]
                chapters.insert(chapters.index(target) + 1, fresh)
                return fresh
            target["scenes"].insert(index + 1, scene)
            return target
        if new_chapter:
            fresh = self._new_chapter(data)
            position = chapters.index(self._chapter(data, chapter)) + 1 if chapter else len(chapters)
            chapters.insert(position, fresh)
            fresh["scenes"].append(scene)
            return fresh
        if chapter:
            target = self._chapter(data, chapter)
        elif chapters:
            target = chapters[-1]
        else:
            target = self._new_chapter(data)
            chapters.append(target)
        if after is None:
            target["scenes"].insert(0, scene)
        else:
            target["scenes"].append(scene)
        return target

    def insert(
        self, content: str, *, chapter: str | None = None, after: Any = END, new_chapter: bool = False,
        by: str, run_id: str = "", origin: dict | None = None, allow_empty: bool = False,
    ) -> str:
        """새 장면을 넣고 그 id를 돌려준다. 빈 장면은 사람이 화면에서 만들 때만 허용한다 (거기에 직접 쓰려고)."""
        text = trim_blank_edges(content)
        if not text.strip() and not allow_empty:
            raise DocError("넣을 글이 비어 있습니다.")
        data = self._load()
        scene = self._new_scene(data)
        self._place(data, scene, chapter, after, new_chapter)
        self._save(data)
        self.docs.apply(Change("write", self.path(scene["id"]), content=text, old=None), by=by, run_id=run_id, origin=origin)
        return scene["id"]

    def move(self, scene_id: str, *, chapter: str | None = None, after: Any = END, new_chapter: bool = False) -> None:
        data = self._load()
        source, index = self._locate(data, scene_id)
        if after not in (None, END) and str(after) == scene_id:
            raise DocError("자기 자신 뒤로는 옮길 수 없습니다.")
        scene = source["scenes"].pop(index)
        self._place(data, scene, chapter, after, new_chapter)
        self._prune(data)
        self._save(data)

    @staticmethod
    def _prune(data: dict) -> None:
        """장면이 다 빠져나간 장은 없앤다. (사용자가 일부러 만든 빈 장은 add_chapter가 표시해 둔다)"""
        data["chapters"] = [c for c in data["chapters"] if c["scenes"] or c.get("keep_empty")]

    def delete(self, scene_id: str, *, by: str, run_id: str = "", origin: dict | None = None) -> None:
        data = self._load()
        chapter, index = self._locate(data, scene_id)
        path = self.path(scene_id)
        old = self.docs.get(path)
        del chapter["scenes"][index]
        self._prune(data)
        self._save(data)
        self.docs.apply(Change("delete", path, old=old), by=by, run_id=run_id, origin=origin)
        self.docs._drop_flags(f"{MANUSCRIPT}/{scene_id}")

    # ------------------------------------------------------------- 나누기·합치기

    def split(
        self, scene_id: str, offsets: list[int], *, new_chapter_at: set[int] | None = None,
        by: str, run_id: str = "", origin: dict | None = None,
    ) -> list[str]:
        """장면을 offsets(글자 위치)에서 잘라 여러 장면으로 만든다. 첫 조각이 원래 id를 갖는다.

        new_chapter_at에 든 조각 번호(1부터, 둘째 조각이 1)에서는 새 장이 시작된다.
        """
        path = self.path(scene_id)
        text = self.docs.get(path)
        if text is None:
            raise DocError(f"원고에 '{scene_id}' 장면이 없습니다.")
        pieces = cut_text(text, offsets)
        if len(pieces) < 2:
            raise DocError("자를 자리가 없습니다.")
        origin = {**(origin or {}), "split_from": scene_id}
        self.docs.apply(Change("write", path, content=pieces[0], old=text), by=by, run_id=run_id, origin=origin)
        ids = [scene_id]
        previous = scene_id
        for n, piece in enumerate(pieces[1:], start=1):
            previous = self.insert(
                piece, after=previous, new_chapter=n in (new_chapter_at or set()),
                by=by, run_id=run_id, origin=origin,
            )
            ids.append(previous)
        return ids

    def import_text(
        self, text: str, offsets: list[int], *, new_chapter_at: set[int] | None = None,
        by: str, run_id: str = "", origin: dict | None = None,
    ) -> list[str]:
        """긴 글을 잘라 원고 끝에 장면들로 넣는다. 조각 번호는 0부터."""
        pieces = cut_text(text, offsets)
        ids: list[str] = []
        previous: Any = END
        for n, piece in enumerate(pieces):
            fresh = n in (new_chapter_at or set())
            if previous is END:
                previous = self.insert(piece, new_chapter=fresh, by=by, run_id=run_id, origin=origin)
            else:
                previous = self.insert(piece, after=previous, new_chapter=fresh, by=by, run_id=run_id, origin=origin)
            ids.append(previous)
        return ids

    def merge(self, scene_ids: list[str], *, by: str, run_id: str = "", origin: dict | None = None) -> str:
        """장면들을 적힌 순서대로 첫 장면에 합친다."""
        ids = list(dict.fromkeys(scene_ids))
        if len(ids) < 2:
            raise DocError("합칠 장면을 둘 이상 적어야 합니다.")
        data = self._load()
        for i in ids:
            self._locate(data, i)
        first = ids[0]
        texts = [self.content(i).strip() for i in ids]
        merged = "\n\n".join(t for t in texts if t)
        origin = {**(origin or {}), "merged": ids}
        self.docs.apply(
            Change("write", self.path(first), content=merged, old=self.docs.get(self.path(first))),
            by=by, run_id=run_id, origin=origin,
        )
        for i in ids[1:]:
            self.delete(i, by=by, run_id=run_id, origin=origin)
        return first

    # ------------------------------------------------------------- 요약

    def set_scene(self, scene_id: str, *, summary: Any = END) -> None:
        """요약을 사람이 직접 정한다. summary=None이면 직접 쓴 요약을 지운다 (도구나 에이전트가 다시 붙일 수 있게 된다)."""
        data = self._load()
        chapter, index = self._locate(data, scene_id)
        scene = chapter["scenes"][index]
        if summary is None:
            scene.update({"summary": "", "summary_hash": "", "summary_manual": False})
        elif summary is not END:
            scene.update({"summary": str(summary).strip(), "summary_hash": "", "summary_manual": True})
        self._save(data)

    def set_summary(self, scene_id: str, summary: str, basis: str) -> None:
        """도구나 에이전트가 만든 요약을 적는다. basis는 요약할 때 본 본문의 해시. 사람이 직접 쓴 요약은 덮지 않는다."""
        data = self._load()
        chapter, index = self._locate(data, scene_id)
        scene = chapter["scenes"][index]
        if scene.get("summary_manual"):
            return
        scene.update({"summary": summary.strip(), "summary_hash": basis})
        self._save(data)

    def stale(self) -> list[str]:
        """요약을 다시 써야 하는 장면들 (직접 쓴 요약은 건드리지 않는다)."""
        out = []
        for c in self._load()["chapters"]:
            for s in c["scenes"]:
                content = self.content(s["id"])
                if content.strip() and self._summary_state(s, content) in ("none", "stale"):
                    out.append(s["id"])
        return out

    # ------------------------------------------------------------- 장

    def add_chapter(self, after: str | None = None) -> str:
        data = self._load()
        chapter = self._new_chapter(data)
        chapter["keep_empty"] = True
        chapters = data["chapters"]
        chapters.insert(chapters.index(self._chapter(data, after)) + 1 if after else len(chapters), chapter)
        self._save(data)
        return chapter["id"]

    def set_chapter(self, chapter_id: str, *, summary: Any = END) -> None:
        data = self._load()
        chapter = self._chapter(data, chapter_id)
        if summary is None:
            chapter.update({"summary": "", "summary_hash": "", "summary_manual": False})
        elif summary is not END:
            chapter.update({"summary": str(summary).strip(), "summary_hash": "", "summary_manual": True})
        self._save(data)

    def move_chapter(self, chapter_id: str, after: str | None) -> None:
        data = self._load()
        chapters = data["chapters"]
        chapter = self._chapter(data, chapter_id)
        if after == chapter_id:
            raise DocError("자기 자신 뒤로는 옮길 수 없습니다.")
        chapters.remove(chapter)
        chapters.insert(chapters.index(self._chapter(data, after)) + 1 if after else 0, chapter)
        self._save(data)

    def delete_chapter(self, chapter_id: str) -> None:
        data = self._load()
        chapter = self._chapter(data, chapter_id)
        if chapter["scenes"]:
            raise DocError("장면이 있는 장은 지울 수 없습니다. 장면을 먼저 옮기거나 지워야 합니다.")
        data["chapters"].remove(chapter)
        self._save(data)
        self.docs._drop_flags(f"{MANUSCRIPT}/{chapter_id}")

    def chapter_basis(self, chapter_id: str) -> tuple[str, str]:
        """장 요약의 재료(장면 요약들을 이은 글)와 그 해시. 요약이 없는 장면이 있으면 재료는 빈 문자열."""
        chapter = self._chapter(self._load(), chapter_id)
        summaries = [s.get("summary", "").strip() for s in chapter["scenes"]]
        if not summaries or not all(summaries):
            return "", ""
        text = "\n".join(f"{i}. {s}" for i, s in enumerate(summaries, start=1))
        return text, content_hash(text)

    def set_chapter_summary(self, chapter_id: str, summary: str, basis: str) -> None:
        data = self._load()
        chapter = self._chapter(data, chapter_id)
        if not chapter.get("summary_manual"):
            chapter.update({"summary": summary.strip(), "summary_hash": basis})
            self._save(data)
