"""작업 공간의 문서 — 입력, 출력, 자료, 원고 본문.

작업 하나의 글은 네 자리에 놓인다. 자리는 앱에 고정돼 있다.

  입력   도구에 넘길 글. 하나뿐이다.
  출력   도구가 낸 글. 하나뿐이고, 도구가 돌 때마다 덮인다.
  자료   폴더를 쓸 수 있는 자유 문서. 글(.md)과 이미지 파일.
  원고   장 아래 장면. 본문은 여기(원고/<장면 id>.md)에, 순서·요약은 manuscript.py에 있다.

문서·폴더·장·장면에는 두 가지 설정을 걸 수 있다. 폴더(장, 원고 전체)에 걸면 안쪽에
적용되고, 더 안쪽에 직접 건 설정이 우선한다.

  수정 방지 (locked)   에이전트와 도구가 고치지 못한다. 사람은 언제나 고칠 수 있다.
  노트 (note)          에이전트의 컨텍스트에 항상 포함된다. 자료에만 건다.

모든 변경은 기록(ledger.jsonl)에 누가·무엇을·어디서 비롯해 썼는지와 함께 남고,
바뀌기 전후의 내용은 버전(versions/)으로 보관된다.

    sessions/<id>/
      docs/                문서들 (실제 파일)
      workspace.json       수정 방지·노트 설정
      manuscript.json      원고의 순서, 요약
      ledger.jsonl         변경 기록
      versions/<hash>      버전 (내용 주소)
      proposals/<id>.json  확인 요청의 기록
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from .manuscript import Manuscript

_BAD_CHARS = re.compile(r'[\x00-\x1f\\:*?"<>|]')
_GLOB_CHARS = re.compile(r"[*?\[]")
MAX_PATH = 200
MAX_DOC_CHARS = 3_000_000
READ_LIMIT = 12_000          # 에이전트가 한 번에 읽는 글자 수. 넘으면 구간으로 나눠 읽는다.

INPUT, OUTPUT, MATERIALS, MANUSCRIPT = "입력", "출력", "자료", "원고"
INPUT_DOC, OUTPUT_DOC = f"{INPUT}.md", f"{OUTPUT}.md"
# 새 작업의 자료에 깔리는 문서들. 제목 한 줄만 있고 전부 노트다. 그 뒤로는 보통 자료와 같다 (고치고 지울 수 있다).
STARTER_DOCS = ("작품 노트", "장기 계획", "단기 계획")

TEXT_SUFFIXES = (".md", ".txt")
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif")
FILE_SUFFIXES = (".pdf",)          # 글을 뽑지 못해 파일 그대로 둔 것 (스캔한 PDF)
ASSET_SUFFIXES = IMAGE_SUFFIXES + FILE_SUFFIXES

_INCLUDE = re.compile(r"@include:[ \t]*((?:(?!@include:)[^\n])+)")
_INCLUDE_QUOTED = re.compile(r"""["'`“‘]([^"'`”’\n]+)["'`”’]""")


class DocError(ValueError):
    """에이전트나 사용자에게 그대로 보여줄 수 있는 오류."""


def normalize_path(path: str, *, allow_folder: bool = False) -> str:
    """경로를 정리하고 검증한다. 글 파일이나 이미지의 확장자가 없으면 .md를 붙인다.

    이름에 점이 들어 있다고 확장자로 보지 않는다. '1. 등탑'이나 '2.5장' 같은 이름이 흔하다.
    """
    raw = str(path or "").strip().replace("\\", "/").strip("/")
    if not raw:
        if allow_folder:
            return ""
        raise DocError("경로가 비어 있습니다.")
    if len(raw) > MAX_PATH:
        raise DocError(f"경로가 너무 깁니다 ({MAX_PATH}자 이내).")
    parts = [p.strip() for p in raw.split("/")]
    for p in parts:
        if not p or p in (".", "..") or p.startswith(".") or _BAD_CHARS.search(p):
            raise DocError(f"쓸 수 없는 경로입니다: {path!r}")
    if not allow_folder and not parts[-1].lower().endswith(TEXT_SUFFIXES + ASSET_SUFFIXES):
        parts[-1] += ".md"
    return "/".join(parts)


def kind_of(path: str) -> str:
    """text | image | file"""
    low = path.lower()
    if low.endswith(TEXT_SUFFIXES):
        return "text"
    if low.endswith(IMAGE_SUFFIXES):
        return "image"
    return "file"


def zone_of(path: str) -> str | None:
    """경로가 놓인 자리: input | output | material | manuscript. 어디에도 안 속하면 None."""
    p = path.strip("/")
    if p in (INPUT, INPUT_DOC):
        return "input"
    if p in (OUTPUT, OUTPUT_DOC):
        return "output"
    if p == MATERIALS or p.startswith(f"{MATERIALS}/"):
        return "material"
    if p == MANUSCRIPT or p.startswith(f"{MANUSCRIPT}/"):
        return "manuscript"
    return None


def natural_key(path: str) -> list:
    """'10장'이 '2장' 뒤에 오도록 숫자를 수로 비교한다."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", path)]


def write_whole(path: Path, text: str) -> None:
    """파일을 통째로 바꿔치기해서 쓴다. 쓰는 도중에 다른 쪽이 읽어도 반쯤 쓰인 파일을 보지 않는다."""
    temp = path.with_name(f"{path.name}.{uuid4().hex[:8]}.tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def content_hash(content: str) -> str:
    return hashlib.sha1(content.encode("utf-8")).hexdigest()[:16]


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def trim_blank_edges(text: str) -> str:
    """앞뒤의 빈 줄만 걷어 낸다. 글 안쪽은 건드리지 않는다."""
    lines = text.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


@dataclass
class Change:
    """문서 하나에 가하려는 변경. 반영 전에 확인을 받을 수 있다."""

    action: str  # write | delete | move
    path: str
    content: str = ""
    old: str | None = None      # 바뀌기 전 내용 (새 문서면 None)
    dest: str = ""              # move의 목적지

    def describe(self) -> str:
        if self.action == "delete":
            return f"'{show_path(self.path)}' 지우기"
        if self.action == "move":
            return f"'{show_path(self.path)}' → '{show_path(self.dest)}' 옮기기"
        return f"'{show_path(self.path)}' {'고치기' if self.old is not None else '새로 쓰기'}"

    @property
    def paths(self) -> list[str]:
        return [self.path] + ([self.dest] if self.action == "move" else [])


def show_path(path: str) -> str:
    """사람과 에이전트에게 보일 경로. 글 문서의 .md는 뗀다."""
    return path[:-3] if path.endswith(".md") else path


def display_name(path: str) -> str:
    """화면에 보일 이름. 자료는 '자료/'를 뗀다 (인물/서윤). 그 밖에는 경로 그대로."""
    shown = show_path(path)
    return shown[len(MATERIALS) + 1:] if shown.startswith(f"{MATERIALS}/") else shown


_DIGIT_FINAL = {"0": 21, "1": 8, "3": 16, "6": 1, "7": 8, "8": 8}   # 영·일·삼·육·칠·팔의 받침 (8 = ㄹ)


def josa(word: str, with_final: str, without: str) -> str:
    """낱말의 끝소리에 맞는 조사. josa('딸', '을', '를') → '을'. '으로'/'로'는 ㄹ 받침도 '로'."""
    core = str(word).rstrip(" '\"」』)]”’")
    if core.endswith(".md"):
        core = core[:-3]
    if not core:
        return without
    ch = core[-1]
    if "가" <= ch <= "힣":
        final = (ord(ch) - 0xAC00) % 28
    elif ch.isdigit():
        final = _DIGIT_FINAL.get(ch, 0)
    else:
        return without
    if with_final == "으로":
        return "으로" if final not in (0, 8) else "로"
    return with_final if final else without


class DocWorkspace:
    def __init__(self, session_dir: Path):
        self.dir = session_dir
        self.root = session_dir / "docs"
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def manuscript(self) -> "Manuscript":
        from .manuscript import Manuscript

        return Manuscript(self)

    # ------------------------------------------------------------- 설정 (수정 방지, 노트)

    def _config(self) -> dict:
        f = self.dir / "workspace.json"
        if f.exists():
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except ValueError:
                pass
        return {}

    def _save_config(self, data: dict) -> None:
        write_whole(self.dir / "workspace.json", json.dumps(data, ensure_ascii=False, indent=2))

    def flags(self) -> dict[str, dict]:
        """직접 걸어 둔 설정만. {경로: {"locked": bool, "note": bool}}"""
        raw = self._config().get("flags")
        return {k: dict(v) for k, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}

    def flag_key(self, path: str) -> str:
        """설정을 걸 때 쓰는 열쇠. 글 문서는 .md까지, 폴더·장·장면은 확장자 없이."""
        target = self.resolve(path)
        if not target:
            raise DocError("경로가 비어 있습니다.")
        zone = zone_of(target)
        if zone == "manuscript":
            return show_path(target)
        if zone != "material":
            raise DocError("수정 방지와 노트는 자료와 원고에만 걸 수 있습니다.")
        return target

    def chain(self, path: str) -> list[str]:
        """이 경로에 적용되는 설정을 찾을 순서. 가장 안쪽부터 바깥으로."""
        target = path.strip("/")
        zone = zone_of(target)
        if zone == "manuscript":
            key = show_path(target)
            if key == MANUSCRIPT:
                return [MANUSCRIPT]
            keys = [key]
            scene_id = key.split("/", 1)[1]
            if scene_id.startswith("s"):
                chapter = self.manuscript.chapter_of(scene_id)
                if chapter:
                    keys.append(f"{MANUSCRIPT}/{chapter}")
            return keys + [MANUSCRIPT]
        if zone == "material":
            keys = [target]
            parent = PurePosixPath(target).parent.as_posix()
            while parent not in (".", ""):
                keys.append(parent)
                parent = PurePosixPath(parent).parent.as_posix()
            return keys
        return []

    def effective(self, path: str, name: str, flags: dict[str, dict] | None = None) -> bool:
        flags = self.flags() if flags is None else flags
        for key in self.chain(path):
            value = flags.get(key, {}).get(name)
            if value is not None:
                return bool(value)
        return False

    def locked(self, path: str) -> bool:
        return self.effective(path, "locked")

    def noted(self, path: str) -> bool:
        return zone_of(path) == "material" and self.effective(path, "note")

    def set_flag(self, path: str, name: str, value: bool | None) -> None:
        """설정을 켜거나(True) 끄거나(False) 상속으로 되돌린다(None)."""
        if name not in ("locked", "note"):
            raise DocError(f"알 수 없는 설정입니다: {name}")
        key = self.flag_key(path)
        if name == "note" and zone_of(key) != "material":
            raise DocError("노트는 자료에만 걸 수 있습니다.")
        config = self._config()
        flags = config.get("flags") if isinstance(config.get("flags"), dict) else {}
        entry = dict(flags.get(key) or {})
        if value is None:
            entry.pop(name, None)
        else:
            entry[name] = bool(value)
        if entry:
            flags[key] = entry
        else:
            flags.pop(key, None)
        config["flags"] = flags
        self._save_config(config)

    def _rename_flags(self, old: str, new: str) -> None:
        """문서나 폴더를 옮기면 거기 걸린 설정도 따라간다."""
        config = self._config()
        flags = config.get("flags")
        if not isinstance(flags, dict):
            return
        moved = {}
        for key in list(flags):
            if key == old or key.startswith(f"{old}/"):
                moved[new + key[len(old):]] = flags.pop(key)
        if moved:
            flags.update(moved)
            config["flags"] = flags
            self._save_config(config)

    def _drop_flags(self, key: str) -> None:
        config = self._config()
        flags = config.get("flags")
        if isinstance(flags, dict) and any(k == key or k.startswith(f"{key}/") for k in flags):
            config["flags"] = {k: v for k, v in flags.items() if k != key and not k.startswith(f"{key}/")}
            self._save_config(config)

    # ------------------------------------------------------------- 경로

    def _file(self, path: str) -> Path:
        target = (self.root / path).resolve()
        if self.root.resolve() not in target.parents:
            raise DocError(f"쓸 수 없는 경로입니다: {path!r}")
        return target

    def exists(self, path: str) -> bool:
        return self._file(path).is_file()

    def is_folder(self, path: str) -> bool:
        p = path.strip("/")
        if p in (MATERIALS, MANUSCRIPT) or re.fullmatch(rf"{MANUSCRIPT}/c\d+", p):
            return True
        return bool(p) and (self.root / p).is_dir()

    def resolve(self, path: str) -> str:
        """적힌 경로를 실제 경로로. 확장자를 빼먹었으면 붙이고, 폴더면 그대로 둔다.

        원고는 '원고/s3'(장면), '원고/2장'·'원고/c2'(장), '원고/1.2'(1장 둘째 장면)로 적을 수 있다.
        """
        raw = str(path or "").strip().replace("\\", "/").strip("/")
        if not raw:
            return ""
        if raw in (INPUT, INPUT_DOC):
            return INPUT_DOC
        if raw in (OUTPUT, OUTPUT_DOC):
            return OUTPUT_DOC
        if raw == MATERIALS:
            return MATERIALS
        head, _, rest = raw.partition("/")
        if head == MANUSCRIPT:
            return self.manuscript.resolve(rest) if rest else MANUSCRIPT
        if re.fullmatch(r"s\d+", raw):
            return self.manuscript.resolve(raw)
        norm = normalize_path(raw, allow_folder=True)
        if (self.root / norm).exists():
            return norm
        if (self.root / f"{norm}.md").is_file():
            return f"{norm}.md"
        return normalize_path(raw)

    def paths(self, under: str = "") -> list[str]:
        """문서 경로들 (이름 순). 원고의 순서는 manuscript가 안다."""
        base = self.root / under if under else self.root
        if not base.exists():
            return []
        if base.is_file():
            return [under]
        found = [f.relative_to(self.root).as_posix() for f in base.rglob("*") if f.is_file()]
        return sorted(found, key=lambda p: natural_key(show_path(p)))   # 확장자는 빼고 견준다 ('서윤'이 '서윤 아버지' 앞)

    # ------------------------------------------------------------- 읽기

    def get(self, path: str) -> str | None:
        f = self._file(path)
        if not f.is_file() or kind_of(path) != "text":
            return None
        return f.read_text(encoding="utf-8")

    def get_bytes(self, path: str) -> bytes | None:
        f = self._file(path)
        return f.read_bytes() if f.is_file() else None

    def text(self, name: str) -> str:
        """입력이나 출력의 글. 없으면 빈 문자열."""
        return self.get(INPUT_DOC if name == INPUT else OUTPUT_DOC) or ""

    def materials(self) -> list[dict]:
        flags = self.flags()
        last = self._last_writers()
        out = []
        for p in self.paths(MATERIALS):
            f = self.root / p
            kind = kind_of(p)
            out.append({
                "path": p,
                "kind": kind,
                "chars": len(f.read_text(encoding="utf-8")) if kind == "text" else 0,
                "size": f.stat().st_size,
                "locked": self.effective(p, "locked", flags),
                "note": self.effective(p, "note", flags),
                "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds"),
                "by": last.get(p, ""),
            })
        return out

    def slot(self, name: str) -> dict:
        """입력이나 출력의 상태."""
        path = INPUT_DOC if name == INPUT else OUTPUT_DOC
        f = self.root / path
        content = self.get(path) or ""
        by = self._last_writers().get(path, "") if content else ""
        return {
            "chars": len(content),
            "updated_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds") if f.is_file() else None,
            "by": by,
            "tool": by[5:] if by.startswith("tool:") else "",
        }

    # ------------------------------------------------------------- 폴더
    #
    # 폴더는 따로 저장하지 않는다. 문서의 경로에서 나온다. 그래서 안의 문서가 다 없어지면 폴더도 없어진다.
    # 다만 사용자가 직접 만든 폴더는 비어 있어도 남긴다 (만들어 놓고 채우려는 것이므로). 그 목록이 설정의 `folders`다.

    def _kept(self) -> list[str]:
        kept = self._config().get("folders")
        return [str(k) for k in kept] if isinstance(kept, list) else []

    def _save_kept(self, kept: list[str]) -> None:
        config = self._config()
        config["folders"] = sorted(dict.fromkeys(kept))
        self._save_config(config)

    def folders(self) -> list[str]:
        """자료의 폴더 전부 ('자료/인물', '자료/인물/조연' …). 빈 폴더도 들어 있다."""
        for k in self._kept():   # 내보냈다 가져온 작업에는 빈 폴더가 없다. 목록에 있으면 다시 만든다
            (self.root / k).mkdir(parents=True, exist_ok=True)
        base = self.root / MATERIALS
        found = [d.relative_to(self.root).as_posix() for d in base.rglob("*") if d.is_dir()] if base.is_dir() else []
        return sorted(found, key=natural_key)

    def create_folder(self, path: str) -> str:
        """자료에 빈 폴더를 만든다. 사용자가 만든 폴더는 비어도 남는다. 이미 있으면 그대로 둔다."""
        target = normalize_path(path, allow_folder=True)
        if zone_of(target) != "material" or target == MATERIALS:
            raise DocError(f"폴더는 '{MATERIALS}/' 아래에 만듭니다.")
        if (self.root / target).is_file():
            raise DocError(f"'{target}'{josa(target, '이라는', '라는')} 파일이 있습니다.")
        (self.root / target).mkdir(parents=True, exist_ok=True)
        # '배경/등대'라고 적어 만들면 '배경'도 사용자가 만든 폴더다. 안쪽 폴더를 옮겨도 남아야 한다.
        parts = target.split("/")
        made = ["/".join(parts[:n]) for n in range(2, len(parts) + 1)]
        self._save_kept([*self._kept(), *made])
        return target

    def _remove_empty_tree(self, folder: str) -> None:
        """폴더와 그 안의 빈 폴더들을 지운다. 문서가 남아 있는 폴더는 건드리지 않는다."""
        base = self.root / folder
        if not base.is_dir():
            return
        for d in sorted((d for d in base.rglob("*") if d.is_dir()), key=lambda d: -len(d.parts)):
            if not any(d.iterdir()):
                d.rmdir()
        if not any(base.iterdir()):
            base.rmdir()
            self._prune_empty(base.parent)

    def material_listing(self, under: str = MATERIALS) -> str:
        """에이전트에게 보여줄 자료 목록."""
        flags = self.flags()
        lines = []
        for p in self.paths(under):
            marks = []
            if self.effective(p, "locked", flags):
                marks.append("수정 방지")
            if self.effective(p, "note", flags):
                marks.append("노트")
            if kind_of(p) == "text":
                size = f"{len((self.root / p).read_text(encoding='utf-8')):,}자"
            else:
                size = "이미지" if kind_of(p) == "image" else "파일"
            lines.append(f"{show_path(p)} ({size})" + (f" [{', '.join(marks)}]" if marks else ""))
        # 사용자가 만들어 둔 빈 폴더도 알려 준다 (거기에 넣으라는 뜻일 수 있다)
        for d in self.folders():
            if (d == under or d.startswith(f"{under}/")) and not any(f.is_file() for f in (self.root / d).rglob("*")):
                lines.append(f"{d}/ (빈 폴더)")
        return "\n".join(lines) if lines else "(자료 없음)"

    def read(self, path: str, start_line: int = 0, end_line: int = 0) -> str:
        """에이전트용 읽기. 폴더면 목록을, 없으면 비슷한 경로를 알려준다. 긴 글은 구간으로 나눠 준다."""
        try:
            target = self.resolve(path)
        except DocError as e:
            return f"오류: {e}"
        if not target:
            return self.overview()
        if target == MANUSCRIPT:
            return self.manuscript.listing(collapse=False)
        if re.fullmatch(rf"{MANUSCRIPT}/c\d+", target):
            return self.manuscript.listing(only=target.split("/", 1)[1], collapse=False)
        if self.is_folder(target):
            return f"'{target}' 폴더의 문서:\n{self.material_listing(target)}"
        if kind_of(target) != "text":
            if self.exists(target):
                return "(글이 아닌 파일입니다. 내용을 읽을 수 없습니다.)"
        content = self.get(target)
        if content is None:
            if target in (INPUT_DOC, OUTPUT_DOC):
                return "(비어 있음)"
            name = PurePosixPath(target).stem.lower()
            near = [show_path(p) for p in self.paths(MATERIALS) if name and name in p.lower()][:5]
            hint = f" 비슷한 문서: {', '.join(near)}" if near else " list로 목록을 볼 수 있습니다."
            return f"'{show_path(target)}' 문서가 없습니다.{hint}"
        if not content:
            return "(비어 있음)"
        return self._window(content, start_line, end_line)

    @staticmethod
    def _window(content: str, start_line: int, end_line: int) -> str:
        lines = content.split("\n")
        total = len(lines)
        whole = start_line <= 1 and end_line <= 0
        if whole and len(content) <= READ_LIMIT:
            return content
        first = max(1, start_line or 1)
        if first > total:
            return f"(이 문서는 {total:,}줄입니다. start_line이 범위를 벗어났습니다.)"
        last = min(total, end_line) if end_line > 0 else total
        picked: list[str] = []
        used = 0
        stop = first - 1
        for i in range(first - 1, last):
            line = lines[i]
            if picked and used + len(line) + 1 > READ_LIMIT:
                break
            picked.append(line)
            used += len(line) + 1
            stop = i + 1
        body = "\n".join(picked)
        if first == 1 and stop >= total:
            return body
        note = f"(전체 {total:,}줄 중 {first:,}–{stop:,}줄."
        if stop < total:
            note += f" 이어 읽으려면 start_line={stop + 1}"
        return f"{body}\n\n{note})"

    def overview(self) -> str:
        """작업 공간 전체의 목록."""
        return "\n\n".join([
            self._slots_line(),
            f"[자료]\n{self.material_listing()}",
            f"[원고]\n{self.manuscript.listing()}",
        ])

    def _slots_line(self) -> str:
        def one(name: str) -> str:
            s = self.slot(name)
            if not s["chars"]:
                return f"{name}: 비어 있음"
            who = {"user": "사용자가 씀", "agent": "에이전트가 씀"}.get(s["by"], f"도구 '{s['tool']}'가 씀" if s["tool"] else "")
            return f"{name}: {s['chars']:,}자" + (f" ({who})" if who else "")

        return f"{one(INPUT)}\n{one(OUTPUT)}"

    def fetch(self, ref: str) -> str:
        """`@include`가 가리키는 글. 문서면 내용, 폴더나 글롭이면 해당 문서들을 이어 붙인다. 없으면 빈 문자열."""
        raw = str(ref or "").strip().strip("/")
        if not raw:
            return ""
        if _GLOB_CHARS.search(raw):
            targets = [p for p in self.paths(MATERIALS) if PurePosixPath(p).full_match(raw) and kind_of(p) == "text"]
        else:
            try:
                target = self.resolve(raw)
            except DocError:
                return ""
            if zone_of(target) == "manuscript" and (target == MANUSCRIPT or self.is_folder(target)):
                return self.manuscript.text(None if target == MANUSCRIPT else target.split("/", 1)[1])
            if self.is_folder(target):
                targets = [p for p in self.paths(target) if kind_of(p) == "text"]
            else:
                return self.get(target) or ""
        blocks = []
        for p in targets:
            content = self.get(p) or ""
            if content.strip():
                blocks.append(f"=== {show_path(p)} ===\n{content}")
        return "\n\n".join(blocks)

    def ref_exists(self, ref: str) -> bool:
        """`@include`가 가리키는 것이 있는가. 비어 있는 원고·출력·폴더도 있는 것이다."""
        raw = str(ref or "").strip().strip("/")
        if not raw:
            return False
        if _GLOB_CHARS.search(raw):
            return bool(self.fetch(raw))
        try:
            target = self.resolve(raw)
        except DocError:
            return False
        if zone_of(target) in ("input", "output") or target in (MATERIALS, MANUSCRIPT):
            return True
        return self.is_folder(target) or self.exists(target)

    def _match_include(self, rest: str) -> tuple[str, int]:
        """`@include:` 뒤의 글에서 경로를 찾는다. (경로, 경로가 끝나는 위치)

        문서 이름에 띄어쓰기가 흔하므로(`자료/작품 노트`) 그 줄에서 실제로 있는 가장 긴 경로를 찾는다.
        따옴표나 백틱으로 감싸면 그 안을 경로로 본다.
        """
        trailing = ".,;:)"
        quoted = _INCLUDE_QUOTED.match(rest)
        if quoted:
            return quoted.group(1).strip(), quoted.end()
        cuts = [m.start() for m in re.finditer(r"[ \t]+", rest)][:12] + [len(rest)]
        for cut in reversed(cuts):
            ref = rest[:cut].rstrip(trailing)
            if ref and self.ref_exists(ref):
                return ref, len(ref)
        ref = rest[:cuts[0]].rstrip(trailing)
        return ref, len(ref)

    def resolve_includes(self, text: str) -> str:
        """글 안의 `@include:경로`를 그 문서의 내용으로 바꾼다. 한 겹만 푼다."""

        def replacer(match: re.Match) -> str:
            rest = match.group(1)
            ref, end = self._match_include(rest)
            if not ref or not self.ref_exists(ref):
                return f"[@include:{ref} — 문서를 찾을 수 없음]" + rest[end:]
            return (self.fetch(ref) or f"({ref}: 비어 있음)") + rest[end:]

        return _INCLUDE.sub(replacer, text)

    def search(self, query: str, under: str = "", limit: int = 40) -> str:
        query = query.strip()
        if not query:
            return "오류: 찾을 말이 비어 있습니다."
        needle = query.lower()
        try:
            target = self.resolve(under) if under.strip() else ""
        except DocError as e:
            return f"오류: {e}"
        if not target:
            pool = [INPUT_DOC, OUTPUT_DOC, *self.paths(MATERIALS), *self.manuscript.scene_paths()]
        elif zone_of(target) == "manuscript":
            only = None if target == MANUSCRIPT else target.split("/", 1)[1]
            pool = self.manuscript.scene_paths(only) if self.is_folder(target) else [target]
        else:
            pool = self.paths(target) if self.is_folder(target) else [target]
        hits: list[str] = []
        for p in pool:
            for n, line in enumerate((self.get(p) or "").splitlines(), start=1):
                if needle in line.lower():
                    hits.append(f"{show_path(p)}:{n}: {line.strip()[:160]}")
                    if len(hits) >= limit:
                        return "\n".join(hits) + f"\n(처음 {limit}곳만 표시)"
        return "\n".join(hits) if hits else f"'{query}'{josa(query, '이', '가')} 나오는 곳이 없습니다."

    def text_paths(self, scope: str = "") -> list[str]:
        """범위 안의 글 문서들 (원고는 순서대로). 범위를 비우면 원고와 자료 전부. 입력·출력은 넣지 않는다."""
        target = self.resolve(scope) if str(scope or "").strip() else ""
        if not target:
            return [*self.manuscript.scene_paths(), *(p for p in self.paths(MATERIALS) if kind_of(p) == "text")]
        if zone_of(target) == "manuscript":
            if target == MANUSCRIPT:
                return self.manuscript.scene_paths()
            if self.is_folder(target):
                return self.manuscript.scene_paths(target.split("/", 1)[1])
            return [target]
        if self.is_folder(target):
            return [p for p in self.paths(target) if kind_of(p) == "text"]
        if self.get(target) is None:
            raise DocError(f"'{show_path(target)}' 문서가 없습니다.")
        return [target]

    def find(self, query: str, scope: str = "all", limit: int = 200) -> tuple[list[dict], bool]:
        """사용자가 쓰는 찾기. (찾은 곳들, 더 있는데 잘렸는지)"""
        needle = query.strip().lower()
        if not needle:
            return [], False
        pool: list[str] = []
        if scope in ("all", "manuscript"):
            pool += self.manuscript.scene_paths()
        if scope in ("all", "materials"):
            pool += [p for p in self.paths(MATERIALS) if kind_of(p) == "text"]
        hits: list[dict] = []
        for p in pool:
            zone = zone_of(p)
            title = self.manuscript.label(show_path(p).split("/", 1)[1]) if zone == "manuscript" else display_name(p)
            for n, line in enumerate((self.get(p) or "").split("\n"), start=1):
                at = line.lower().find(needle)
                while at != -1:
                    if len(hits) >= limit:
                        return hits, True
                    hits.append({"path": show_path(p), "title": title, "zone": zone, "line": n, "start": at, "text": line.strip()[:240]})
                    at = line.lower().find(needle, at + len(needle))
        return hits, False

    # ------------------------------------------------------------- 변경 계획

    def plan_write(self, path: str, content: str) -> Change:
        target = self.resolve(path)
        if not target or self.is_folder(target):
            raise DocError(f"'{path}'{josa(path, '은', '는')} 폴더입니다. 문서 경로를 적어야 합니다.")
        if zone_of(target) is None:
            raise DocError(f"'{path}'에는 문서를 둘 수 없습니다. 문서는 '{MATERIALS}/' 아래에 둡니다.")
        if kind_of(target) != "text":
            raise DocError("글 문서만 쓸 수 있습니다.")
        if len(content) > MAX_DOC_CHARS:
            raise DocError("문서 하나가 너무 깁니다.")
        old = self.get(target)
        if zone_of(target) == "manuscript" and old is None:
            raise DocError("새 장면은 경로를 적어 만들 수 없습니다. 원고에 장면 넣기를 써야 합니다.")
        return Change("write", target, content=content, old=old)

    def plan_edit(self, path: str, old_text: str, new_text: str) -> Change:
        target = self.resolve(path)
        current = self.get(target)
        if current is None:
            raise DocError(f"'{show_path(target)}' 문서가 없습니다.")
        count = current.count(old_text) if old_text else 0
        if count == 0:
            raise DocError("일치하는 글을 찾을 수 없습니다.")
        if count > 1:
            raise DocError(f"일치하는 글이 {count}곳에 있습니다. 주변 글을 더 포함해 한 곳만 가리켜야 합니다.")
        return Change("write", target, content=current.replace(old_text, new_text, 1), old=current)

    def plan_delete(self, path: str) -> Change:
        target = self.resolve(path)
        if zone_of(target) == "manuscript":
            raise DocError("장면은 원고에서 지우기를 써야 합니다.")
        f = self._file(target)
        if not f.is_file():
            raise DocError(f"'{show_path(target)}' 문서가 없습니다.")
        return Change("delete", target, old=self.get(target))

    def plan_move(self, src: str, dst: str) -> Change:
        source = self.resolve(src)
        if zone_of(source) == "manuscript" or zone_of(self._dest(dst, source)) == "manuscript":
            raise DocError("원고의 장면은 이 방법으로 옮길 수 없습니다. 원고에 넣기, 장면 옮기기를 써야 합니다.")
        if source == INPUT_DOC:
            raise DocError("입력은 옮길 수 없습니다.")
        if not self._file(source).is_file():
            raise DocError(f"'{show_path(source)}' 문서가 없습니다.")
        dest = self._dest(dst, source)
        if zone_of(dest) != "material":
            raise DocError(f"'{MATERIALS}/' 아래로만 옮길 수 있습니다.")
        if dest == source:
            raise DocError("같은 경로입니다.")
        if self.exists(dest):
            raise DocError(f"'{show_path(dest)}'에 이미 문서가 있습니다. 먼저 지우거나 다른 이름을 써야 합니다.")
        current = self.get(source)
        return Change("move", source, content=current or "", old=current, dest=dest)

    def _dest(self, dst: str, source: str) -> str:
        """옮길 곳. 이미지는 확장자를 그대로 가져간다."""
        raw = str(dst or "").strip().replace("\\", "/").strip("/")
        if kind_of(source) != "text" and not raw.lower().endswith(ASSET_SUFFIXES):
            raw += PurePosixPath(source).suffix
        return normalize_path(raw)

    # ------------------------------------------------------------- 반영

    def apply(self, change: Change, *, by: str, run_id: str = "", origin: dict | None = None) -> str:
        """변경을 실제로 반영하고 기록에 남긴다. by: 'user' | 'agent' | 'tool:<이름>' | 'starter'(시작 자료)."""
        f = self._file(change.path)
        name = show_path(change.path)
        if change.action == "write":
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(change.content, encoding="utf-8")
            self._record("write", change.path, by, run_id, new=change.content, old=change.old, origin=origin)
            if change.path in (INPUT_DOC, OUTPUT_DOC):
                return f"{name}에 썼습니다 ({len(change.content):,}자)." if change.content else f"{name}을 비웠습니다."
            verb = "고쳤습니다" if change.old is not None else "새로 썼습니다"
            return f"'{name}' 문서를 {verb} ({len(change.content):,}자)."
        if change.action == "delete":
            if f.is_file():
                f.unlink()
                self._prune_empty(f.parent)
            self._drop_flags(change.path)
            self._record("delete", change.path, by, run_id, old=change.old, origin=origin)
            return f"'{name}' 문서를 지웠습니다."
        if change.action == "move":
            dest = self._file(change.dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            f.replace(dest)
            self._prune_empty(f.parent)
            self._rename_flags(change.path, change.dest)
            self._record(
                "move", change.path, by, run_id, new=change.old, old=change.old, to=change.dest, origin=origin
            )
            dest_name = show_path(change.dest)
            return f"'{name}'{josa(name, '을', '를')} '{dest_name}'{josa(dest_name, '으로', '로')} 옮겼습니다."
        raise DocError(f"알 수 없는 변경: {change.action}")

    def clear(self, name: str, *, by: str, run_id: str = "", origin: dict | None = None) -> None:
        """입력이나 출력을 비운다. 비어 있으면 아무 일도 하지 않는다."""
        path = INPUT_DOC if name == INPUT else OUTPUT_DOC
        old = self.get(path)
        if old:
            self.apply(Change("write", path, content="", old=old), by=by, run_id=run_id, origin=origin)

    def save_file(self, path: str, data: bytes, *, by: str, run_id: str = "") -> str:
        """이미지 같은 파일을 자료에 넣는다. 같은 이름이 있으면 번호를 붙인다."""
        target = self.free_path(normalize_path(path))
        if zone_of(target) != "material":
            raise DocError(f"파일은 '{MATERIALS}/' 아래에 둡니다.")
        f = self._file(target)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        self._record("write", target, by, run_id, origin={"file": True, "size": len(data)})
        return target

    def free_path(self, path: str) -> str:
        """그 경로가 비어 있으면 그대로, 아니면 이름 뒤에 번호를 붙인 경로."""
        if not self._file(path).exists():
            return path
        p = PurePosixPath(path)
        n = 2
        while self._file(f"{p.parent.as_posix()}/{p.stem} {n}{p.suffix}").exists():
            n += 1
        return f"{p.parent.as_posix()}/{p.stem} {n}{p.suffix}"

    def move_folder(self, source: str, destination: str, *, by: str) -> list[str]:
        """자료의 폴더 안 문서를 전부 다른 폴더로 옮긴다. 하나라도 옮길 수 없으면 아무것도 옮기지 않는다."""
        src = normalize_path(source, allow_folder=True)
        dst = normalize_path(destination, allow_folder=True)
        if zone_of(src) != "material" or zone_of(dst) != "material" or src == MATERIALS:
            raise DocError(f"'{MATERIALS}/' 아래의 폴더만 옮길 수 있습니다.")
        if dst == src or dst.startswith(f"{src}/"):
            raise DocError("같은 폴더이거나 그 안쪽으로는 옮길 수 없습니다.")
        if not (self.root / src).is_dir():
            raise DocError(f"'{src}' 폴더가 없습니다.")
        changes = [self.plan_move(p, f"{dst}/{p[len(src) + 1:]}") for p in self.paths(src)]
        for change in changes:
            self.apply(change, by=by, origin={"folder_moved": f"{src} → {dst}"})
        self._rename_flags(src, dst)
        # 빈 폴더(와 안에 든 빈 폴더들)도 같이 옮긴다. 사용자가 만든 폴더라는 표시도 따라간다.
        empties = [d.relative_to(self.root).as_posix() for d in (self.root / src).rglob("*") if d.is_dir()] if (self.root / src).is_dir() else []
        kept = self._kept()
        was_kept = src in kept or not changes
        for d in empties:
            (self.root / f"{dst}{d[len(src):]}").mkdir(parents=True, exist_ok=True)
        (self.root / dst).mkdir(parents=True, exist_ok=True)
        moved_kept = [f"{dst}{k[len(src):]}" if k == src or k.startswith(f"{src}/") else k for k in kept]
        self._save_kept([*moved_kept, *([dst] if was_kept else [])])
        self._remove_empty_tree(src)
        return [c.dest for c in changes]

    def delete_folder(self, folder: str, *, by: str) -> list[str]:
        src = normalize_path(folder, allow_folder=True)
        if zone_of(src) != "material" or src == MATERIALS or not (self.root / src).is_dir():
            raise DocError(f"'{folder}' 폴더가 없습니다.")
        paths = self.paths(src)
        for p in paths:
            self.apply(Change("delete", p, old=self.get(p)), by=by, origin={"folder_deleted": src})
        self._drop_flags(src)
        self._save_kept([k for k in self._kept() if k != src and not k.startswith(f"{src}/")])
        self._remove_empty_tree(src)
        return paths

    def _prune_empty(self, folder: Path) -> None:
        root = self.root.resolve()
        folder = folder.resolve()
        kept = {(root / k).resolve() for k in self._kept()}   # 사용자가 만든 폴더는 비어도 남긴다
        while folder != root and root in folder.parents and folder.is_dir() and folder not in kept and not any(folder.iterdir()):
            folder.rmdir()
            folder = folder.parent

    # ------------------------------------------------------------- 기록과 버전

    def _save_version(self, content: str) -> str:
        h = content_hash(content)
        d = self.dir / "versions"
        d.mkdir(exist_ok=True)
        f = d / h
        if not f.exists():
            f.write_text(content, encoding="utf-8")
        return h

    def _record(
        self, action: str, path: str, by: str, run_id: str,
        *, new: str | None = None, old: str | None = None, to: str = "", origin: dict | None = None,
    ) -> dict:
        entry = {
            "seq": self.ledger_seq() + 1,
            "timestamp": _now(),
            "action": action,
            "path": path,
            "by": by,
        }
        if to:
            entry["to"] = to
        if run_id:
            entry["run_id"] = run_id
        if new is not None:
            entry["hash"] = self._save_version(new)
            entry["chars"] = len(new)
        if old is not None:
            entry["prev_hash"] = self._save_version(old)
        if origin:
            entry["origin"] = origin  # 어디서 비롯했나: 도구 호출, 확인 요청 id, 올린 파일 등
        with (self.dir / "ledger.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return entry

    def ledger(self) -> list[dict]:
        f = self.dir / "ledger.jsonl"
        if not f.exists():
            return []
        out = []
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def ledger_seq(self) -> int:
        entries = self.ledger()
        return entries[-1]["seq"] if entries else 0

    def _last_writers(self) -> dict[str, str]:
        last: dict[str, str] = {}
        for e in self.ledger():
            if e["action"] == "move":
                last[e["to"]] = last.pop(e["path"], e["by"])
            elif e["action"] == "delete":
                last.pop(e["path"], None)
            else:
                last[e["path"]] = e["by"]
        return last

    def history(self, path: str) -> list[dict]:
        """문서 하나의 버전 기록. 옮겨 온 문서면 옮기기 전의 기록까지 거슬러 올라간다."""
        try:
            target = self.resolve(path)
        except DocError:
            target = normalize_path(path)   # 지워진 장면처럼 지금은 없는 것의 기록도 볼 수 있어야 한다
        names = {target}
        chain: list[dict] = []
        for e in reversed(self.ledger()):
            if e["action"] == "move" and e.get("to") in names:
                names.add(e["path"])
                chain.append(e)
            elif e["path"] in names:
                chain.append(e)
        return list(reversed(chain))

    def version(self, version_hash: str) -> str | None:
        if not re.fullmatch(r"[0-9a-f]{16}", version_hash or ""):
            return None
        f = self.dir / "versions" / version_hash
        return f.read_text(encoding="utf-8") if f.exists() else None

    def deleted(self) -> list[dict]:
        """지워진 채로 있는 글 문서와 장면. 버전 기록에서 복원할 수 있는 것만, 최근에 지운 것부터.

        다른 경로로 복원된 것(지운 장면은 새 장면으로 돌아온다)과 합쳐져 없어진 장면은 뺀다.
        """
        gone: dict[str, dict] = {}
        for e in self.ledger():
            origin = e.get("origin") or {}
            if origin.get("restored_path"):
                gone.pop(normalize_path(origin["restored_path"]), None)
            if e["action"] == "delete":
                if e.get("prev_hash") and not origin.get("merged"):
                    gone[e["path"]] = e
            elif e["action"] == "move":
                gone.pop(e.get("to", ""), None)
            else:
                gone.pop(e["path"], None)
        items = []
        for path, e in gone.items():
            if self._file(path).exists():
                continue
            content = self.version(e["prev_hash"]) or ""
            if not content.strip():
                continue   # 빈 채로 지운 것은 되살릴 것이 없다
            head = next((line.strip() for line in content.splitlines() if line.strip()), "")
            items.append({
                "path": show_path(path),
                "kind": "scene" if zone_of(path) == "manuscript" else "doc",
                "deleted_at": e["timestamp"],
                "seq": e["seq"],
                "by": e["by"],
                "hash": e["prev_hash"],
                "chars": len(content),
                "head": head[:80],
            })
        items.sort(key=lambda i: i["seq"], reverse=True)
        return [{k: v for k, v in i.items() if k != "seq"} for i in items]   # seq는 줄 세우는 데만 쓴다

    # ------------------------------------------------------------- 확인 요청의 기록

    def record_proposal(self, data: dict, *, by: str, run_id: str) -> dict:
        d = self.dir / "proposals"
        d.mkdir(exist_ok=True)
        proposal = {
            "id": uuid4().hex[:12],
            "seq": sum(1 for _ in d.glob("*.json")) + 1,   # 같은 초에 올라온 것의 순서를 지킨다
            "created_at": _now(),
            **data,
            "by": by,
            "run_id": run_id,
            "status": "pending",
            "note": "",
        }
        (d / f"{proposal['id']}.json").write_text(json.dumps(proposal, ensure_ascii=False, indent=2), encoding="utf-8")
        return proposal

    def decide_proposal(self, proposal_id: str, status: str, note: str = "") -> None:
        f = self.dir / "proposals" / f"{proposal_id}.json"
        if not f.exists():
            return
        data = json.loads(f.read_text(encoding="utf-8"))
        data.update({"status": status, "note": note, "decided_at": _now()})
        f.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def proposals(self) -> list[dict]:
        d = self.dir / "proposals"
        if not d.exists():
            return []
        items = []
        for f in d.glob("*.json"):
            try:
                items.append(json.loads(f.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return sorted(items, key=lambda p: (p.get("created_at", ""), p.get("seq", 0)))

    # ------------------------------------------------------------- 에이전트가 늘 들고 있는 것

    def standing_context(self, *, note_limit: int = 8000, list_limit: int = 200, manuscript_limit: int = 12000) -> str:
        parts: list[str] = []

        notes = [m["path"] for m in self.materials() if m["note"] and m["kind"] == "text"]
        for p in notes:
            content = self.get(p) or ""
            if len(content) > note_limit:
                content = content[:note_limit] + f"\n…(이하 {len(content) - note_limit:,}자 생략 — read로 전체를 읽을 수 있음)"
            parts.append(f'<note path="{show_path(p)}">\n{content or "(비어 있음)"}\n</note>')

        parts.append(f"<work>\n{self._slots_line()}\n</work>")

        listing = self.material_listing().splitlines()
        if len(listing) > list_limit:
            listing = listing[:list_limit] + [f"…(외 {len(listing) - list_limit}개 — list('{MATERIALS}')로 전체 확인)"]
        parts.append("<materials>\n" + "\n".join(listing) + "\n</materials>")

        parts.append("<manuscript>\n" + self.manuscript.listing(limit=manuscript_limit) + "\n</manuscript>")

        recent = self.changes_since(int(self._config().get("last_run_seq") or 0))
        if recent:
            parts.append(
                "<changed_since_last_run>\n"
                "지난 실행 이후 사용자가 직접 한 일이다. 기억에 의존하지 말고 필요하면 다시 읽어라.\n"
                + "\n".join(recent)
                + "\n</changed_since_last_run>"
            )
        return "\n\n".join(parts)

    def changes_since(self, seq: int) -> list[str]:
        """지난 실행 뒤에 사용자가 고친 문서와 직접 돌린 도구."""
        verbs = {"write": "고침", "delete": "지움", "move": "옮김"}
        seen: dict[str, str] = {}
        for e in self.ledger():
            if e["seq"] <= seq:
                continue
            origin = e.get("origin") or {}
            target = show_path(e.get("to") or e["path"])
            if e["by"] == "user":
                seen[target] = f"- {target} ({verbs.get(e['action'], e['action'])})"
            elif origin.get("direct"):
                seen[target] = f"- {target} (사용자가 '{origin.get('label') or e['by'][5:]}' 도구를 직접 돌려 나온 결과)"
        return list(seen.values())[-40:]

    def mark_run_started(self) -> None:
        config = self._config()
        config["last_run_seq"] = self.ledger_seq()
        self._save_config(config)

    # ------------------------------------------------------------- 시작 자료

    def initialize(self) -> None:
        """새 작업의 시작 자료를 깐다. 제목 한 줄만 든 문서들이고 전부 노트다. 이미 있는 문서는 덮어쓰지 않는다."""
        for name in STARTER_DOCS:
            target = normalize_path(f"{MATERIALS}/{name}")
            if not self.exists(target):
                self.apply(Change("write", target, content=f"# {name}\n", old=None), by="starter")
            self.set_flag(target, "note", True)
