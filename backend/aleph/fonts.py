"""사용자가 올린 폰트 — 파일 하나가 폰트의 한 모양(보통, 굵게 …)이다.

    data/fonts/
      fonts.json        올린 폰트의 목록
      <id>.<확장자>     폰트 파일 (id는 내용의 해시라서 같은 파일을 두 번 올려도 하나다)

폰트의 이름과 굵기는 파일 안에 적힌 것을 읽는다. 같은 이름의 파일들이 한 폰트를 이루고,
화면은 그것을 묶어 `@font-face`로 건다. 앱 전체의 설정이라 작업 파일에는 들어가지 않는다.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path, PurePosixPath

from fontTools.ttLib import TTFont

MAX_FONT = 40 * 1024 * 1024
KOREAN = 0x412   # 이름 표의 한국어 (Windows)

# 파일 머리의 표시 → (@font-face의 format, 확장자, 내려줄 때의 종류)
_KINDS = {
    b"\x00\x01\x00\x00": ("truetype", "ttf", "font/ttf"),
    b"true": ("truetype", "ttf", "font/ttf"),
    b"OTTO": ("opentype", "otf", "font/otf"),
    b"wOFF": ("woff", "woff", "font/woff"),
    b"wOF2": ("woff2", "woff2", "font/woff2"),
}
_MEDIA = {ext: media for _, ext, media in _KINDS.values()}


class FontError(ValueError):
    """사용자에게 그대로 보여줄 수 있는 이유."""


def _name(table, *ids: int) -> str:
    """이름 표에서 고른다. 한글 이름이 있으면 그것, 없으면 영문."""
    for name_id in ids:
        korean = next((r for r in table.names if r.nameID == name_id and r.platformID == 3 and r.langID == KOREAN), None)
        text = (korean.toUnicode() if korean is not None else table.getDebugName(name_id)) or ""
        if text.strip():
            return text.strip()
    return ""


def describe(data: bytes) -> dict:
    """폰트 파일에서 이름, 모양, 굵기를 읽는다."""
    kind = _KINDS.get(data[:4])
    if kind is None:
        if data[:4] == b"ttcf":
            raise FontError("여러 폰트를 묶은 파일(ttc)은 받지 않습니다. 폰트 하나짜리 파일(ttf, otf, woff, woff2)을 올려야 합니다.")
        raise FontError("폰트 파일이 아닙니다 (ttf, otf, woff, woff2만 받습니다).")
    try:
        font = TTFont(io.BytesIO(data), lazy=True)
        names = font["name"]
        family = _name(names, 16, 1)       # 16·17: 굵기별로 나뉘지 않은 이름. 없으면 1·2
        style = _name(names, 17, 2) if _name(names, 16) else _name(names, 2)
        os2 = font["OS/2"] if "OS/2" in font else None
        weight = int(os2.usWeightClass) if os2 is not None else 400
        low = high = min(1000, max(1, weight))
        if "fvar" in font:   # 가변 폰트: 굵기가 범위다
            axis = next((a for a in font["fvar"].axes if a.axisTag == "wght"), None)
            if axis is not None:
                low, high = int(axis.minValue), int(axis.maxValue)
        italic = bool(os2 is not None and os2.fsSelection & 1) or bool("head" in font and font["head"].macStyle & 2)
    except FontError:
        raise
    except Exception as e:
        raise FontError("폰트 파일을 읽지 못했습니다. 파일이 깨졌을 수 있습니다.") from e
    if not family:
        raise FontError("폰트 파일에 이름이 없습니다.")
    return {"family": family, "style": style or "Regular", "weight": [low, high], "italic": italic, "format": kind[0], "ext": kind[1]}


class FontStore:
    def __init__(self, folder: Path):
        self.folder = folder
        self.index = folder / "fonts.json"

    def _load(self) -> dict[str, dict]:
        if not self.index.exists():
            return {}
        try:
            data = json.loads(self.index.read_text(encoding="utf-8"))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, fonts: dict[str, dict]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        self.index.write_text(json.dumps(fonts, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _public(font_id: str, entry: dict) -> dict:
        return {
            "id": font_id,
            **{k: entry[k] for k in ("family", "style", "weight", "italic", "format", "size", "file")},
            "url": f"/api/fonts/{font_id}/file",
        }

    def list(self) -> list[dict]:
        fonts = [self._public(i, e) for i, e in self._load().items() if (self.folder / f"{i}.{e['ext']}").exists()]
        return sorted(fonts, key=lambda f: (f["family"].casefold(), f["weight"][0], f["italic"], f["style"]))

    def add(self, filename: str, data: bytes) -> dict:
        if not data:
            raise FontError("빈 파일입니다.")
        if len(data) > MAX_FONT:
            raise FontError("파일이 너무 큽니다 (40MB 이내).")
        info = describe(data)
        font_id = hashlib.sha1(data).hexdigest()[:16]
        fonts = self._load()
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / f"{font_id}.{info['ext']}").write_bytes(data)
        name = PurePosixPath(filename.replace("\\", "/")).name.strip() or f"{info['family']}.{info['ext']}"
        fonts[font_id] = {**info, "size": len(data), "file": fonts.get(font_id, {}).get("file") or name}
        self._save(fonts)
        return self._public(font_id, fonts[font_id])

    def file(self, font_id: str) -> tuple[Path, str] | None:
        """(파일의 자리, 내려줄 때의 종류). 없으면 None."""
        entry = self._load().get(font_id)   # 목록에 있는 id만 받으므로 경로를 지어낼 수 없다
        if entry is None:
            return None
        path = self.folder / f"{font_id}.{entry['ext']}"
        return (path, _MEDIA[entry["ext"]]) if path.exists() else None

    def delete(self, font_id: str) -> bool:
        fonts = self._load()
        entry = fonts.pop(font_id, None)
        if entry is None:
            return False
        (self.folder / f"{font_id}.{entry['ext']}").unlink(missing_ok=True)
        self._save(fonts)
        return True
