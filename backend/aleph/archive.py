"""파일로 내보내기·가져오기 — 작업은 `.aleph`, 프리셋은 `.alephpreset`.

둘 다 속은 zip이고, 맨 위의 `aleph.json`이 무슨 파일인지 말해 준다.

    <이름>.alephpreset          <이름>.aleph
      aleph.json                  aleph.json
      preset.yaml                 preset/…     쓰던 프리셋 (왼쪽과 같은 모양)
      instruction.md              session/…    작업 폴더 그대로 (문서, 원고, 버전 기록, 대화, 실행 기록)
      tools/<name>.md
      starter/…

컴퓨터를 옮기거나, 글이 나온 과정까지 남에게 보여 줄 때 쓴다. 키나 설정은 들어가지 않는다.
가져올 때는 파일 안을 보고 종류를 가리므로, 어느 것을 넣어도 맞는 쪽으로 들어온다.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING

from .presets.store import PresetError, preset_files

if TYPE_CHECKING:
    from .context import AppContext

MANIFEST = "aleph.json"
FORMAT = 1
WORK, PRESET = "work", "preset"
SUFFIX = {WORK: ".aleph", PRESET: ".alephpreset"}
PRESET_DIR = "preset/"
SESSION_DIR = "session/"
MAX_ARCHIVE = 300 * 1024 * 1024
MAX_UNPACKED = 1024 * 1024 * 1024


class ArchiveError(ValueError):
    """사용자에게 그대로 보여줄 수 있는 이유."""


def file_name(name: str, kind: str) -> str:
    """내려받을 파일의 이름. 파일 이름에 쓸 수 없는 글자는 뺀다."""
    safe = "".join(c for c in name if c not in '\\/:*?"<>|' and c >= " ").strip(" .")
    return (safe or ("작업" if kind == WORK else "프리셋")) + SUFFIX[kind]


def _manifest(kind: str, name: str, **extra) -> str:
    return json.dumps({
        "app": "ALEPH",
        "kind": kind,
        "format": FORMAT,
        "name": name,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        **extra,
    }, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------- 내보내기

def export_preset(ctx: "AppContext", preset_id: str) -> tuple[str, bytes] | None:
    """(파일 이름, 내용). 그런 프리셋이 없으면 None."""
    preset = ctx.presets.get(preset_id)
    if preset is None:
        return None
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(MANIFEST, _manifest(PRESET, preset.name, id=preset.id))
        for rel, content in preset_files(preset).items():
            z.writestr(rel, content)
    return file_name(preset.name, PRESET), buffer.getvalue()


def export_session(ctx: "AppContext", session_id: str) -> tuple[str, bytes]:
    session_dir = ctx.sessions.path(session_id)
    name = ctx.sessions.meta(session_id).get("name") or ""
    state = ctx.state(session_id)
    preset = ctx.presets.get(state.preset_id) if state.preset_id else None
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(MANIFEST, _manifest(WORK, name, preset_id=preset.id if preset else ""))
        if preset is not None:
            for rel, content in preset_files(preset).items():
                z.writestr(PRESET_DIR + rel, content)
        for f in sorted(session_dir.rglob("*")):
            if f.is_file():
                z.write(f, SESSION_DIR + f.relative_to(session_dir).as_posix())
    return file_name(name, WORK), buffer.getvalue()


# ---------------------------------------------------------------------- 가져오기

def import_file(ctx: "AppContext", data: bytes) -> dict:
    """내보낸 파일을 들여온다. 작업이면 새 작업으로, 프리셋이면 새 프리셋으로.

    반환: {kind: "work", id, name, preset_id} | {kind: "preset", preset}
    """
    if len(data) > MAX_ARCHIVE:
        raise ArchiveError("파일이 너무 큽니다 (300MB 이내).")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ArchiveError("ALEPH에서 내보낸 파일이 아닙니다.") from e
    with z:
        if MANIFEST not in z.namelist():
            raise ArchiveError("ALEPH에서 내보낸 파일이 아닙니다.")
        try:
            manifest = json.loads(z.read(MANIFEST).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise ArchiveError("파일의 내용을 읽지 못했습니다.") from e
        if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or manifest.get("kind") not in SUFFIX:
            raise ArchiveError("이 버전에서 읽을 수 없는 파일입니다.")
        if sum(i.file_size for i in z.infolist()) > MAX_UNPACKED:
            raise ArchiveError("풀었을 때의 크기가 너무 큽니다.")
        try:
            if manifest["kind"] == PRESET:
                preset = ctx.presets.import_files(_texts(z, ""), str(manifest.get("id") or ""))
                return {"kind": PRESET, "preset": preset}
            return {"kind": WORK, **_import_session(ctx, z, manifest)}
        except PresetError as e:
            raise ArchiveError(str(e)) from e


def _inside(rel: str) -> PurePosixPath | None:
    """zip 안의 경로가 받을 폴더 안에 머무는가. 밖으로 나가려는 것은 None."""
    path = PurePosixPath(rel)
    if not rel or "\\" in rel or ":" in rel or path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        return None
    return path


def _texts(z: zipfile.ZipFile, prefix: str) -> dict[str, str]:
    """prefix 밑의 글 파일들 (상대 경로 → 내용)."""
    out: dict[str, str] = {}
    for info in z.infolist():
        name = info.filename
        if info.is_dir() or not name.startswith(prefix) or name == MANIFEST:
            continue
        rel = _inside(name[len(prefix):])
        if rel is None:
            continue
        try:
            out[rel.as_posix()] = z.read(info).decode("utf-8")
        except UnicodeDecodeError:
            continue
    return out


def _import_session(ctx: "AppContext", z: zipfile.ZipFile, manifest: dict) -> dict:
    meta_file = SESSION_DIR + "meta.json"
    if meta_file not in z.namelist():
        raise ArchiveError("작업 파일에 작업이 들어 있지 않습니다.")
    try:
        meta = json.loads(z.read(meta_file).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise ArchiveError("파일의 내용을 읽지 못했습니다.") from e
    if not isinstance(meta, dict):
        raise ArchiveError("파일의 내용을 읽지 못했습니다.")

    name = str(meta.get("name") or manifest.get("name") or "가져온 작업")
    taken = {s["name"] for s in ctx.sessions.list_sessions()}
    if name in taken:   # 같은 이름의 작업이 있으면 구분되게 한다
        base, n = f"{name} (가져옴)", 2
        name = base
        while name in taken:
            name = f"{base} {n}"
            n += 1
    created = ctx.sessions.create_session(name)
    session_dir = ctx.sessions.path(created["id"])
    root = session_dir.resolve()
    for info in z.infolist():
        if info.is_dir() or not info.filename.startswith(SESSION_DIR):
            continue
        rel = _inside(info.filename[len(SESSION_DIR):])
        if rel is None:
            continue   # 폴더 밖으로 나가려는 경로는 버린다
        target = (session_dir / rel.as_posix()).resolve()
        if root not in target.parents:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(z.read(info))

    # 쓰던 프리셋: 같은 id가 이 컴퓨터에 있으면 그것을 쓰고, 없으면 같이 들여온다.
    preset_id = str(manifest.get("preset_id") or meta.get("preset_id") or "")
    if preset_id and ctx.presets.get(preset_id) is None:
        files = _texts(z, PRESET_DIR)
        try:
            preset_id = ctx.presets.import_files(files, preset_id, keep_name=True).id if files else ""
        except PresetError:
            preset_id = ""
    if not preset_id or ctx.presets.get(preset_id) is None:
        preset_id = ctx.presets.first_id()

    imported = ctx.sessions.meta(created["id"])   # 파일 안의 meta.json이 덮어썼다
    imported.update({"name": created["name"], "preset_id": preset_id, "imported_at": created["created_at"]})
    imported.setdefault("created_at", created["created_at"])
    ctx.sessions.save_meta(created["id"], imported)
    return {"id": created["id"], "name": created["name"], "preset_id": preset_id}
