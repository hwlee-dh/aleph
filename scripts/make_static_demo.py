"""작업 하나를 서버 없이 볼 수 있는 정적 사이트로 뽑는다 (GitHub Pages 같은 곳에 올린다).

    cd backend
    uv run python ../scripts/make_static_demo.py [작업.aleph] [--out 폴더] [--no-build]

작업을 주지 않으면 시연 서버에 들어 있는 것(`backend/scripts/demo/aleph-demo.aleph`)을 쓴다.
화면을 `vite build --mode static`으로 빌드하고, 그 화면이 읽을 응답을 엔진에서 미리 받아 `snapshot/`에 파일로 둔다.
결과는 `release/static-demo/`에 놓인다. 읽기 전용이다: 요청 보내기, 고치기, 찾기, 내려받기는 되지 않는다.

    cd release/static-demo && python -m http.server 8780     # 미리 보기: http://127.0.0.1:8780
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote, urlsplit

import httpx

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend"))

from aleph import archive  # noqa: E402
from aleph.app import create_app  # noqa: E402
from aleph.settings import AppPaths  # noqa: E402

DEMO_WORK = REPO / "backend" / "scripts" / "demo" / "aleph-demo.aleph"


def build_frontend(out: Path) -> None:
    npm = shutil.which("npx")
    if npm is None:
        sys.exit("npx(Node.js)를 찾지 못했습니다.")
    subprocess.run([npm, "vite", "build", "--mode", "static", "--outDir", str(out), "--emptyOutDir"], cwd=REPO / "frontend", check=True)


def request_key(url: str) -> str:
    """요청을 가리키는 열쇠: 경로와, 이름순으로 줄 세운 질의. 화면(frontend/src/lib/snapshot.ts)과 같은 규칙이다."""
    parts = urlsplit(url)
    query = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(parts.query, keep_blank_values=True), key=lambda kv: kv[0]))
    return unquote(parts.path) + (f"?{query}" if query else "")


async def take_snapshot(work: Path, out: Path) -> tuple[int, int]:
    """엔진을 임시 데이터로 띄워 그 작업을 넣고, 화면이 읽는 응답을 전부 받아 파일로 적는다. (응답 수, 파일 수)"""
    snapshot = out / "snapshot"
    (snapshot / "files").mkdir(parents=True, exist_ok=True)
    entries: dict[str, str] = {}
    files: dict[str, str] = {}

    with tempfile.TemporaryDirectory(prefix="aleph-static-") as temp:
        app = create_app(AppPaths(data=Path(temp) / "data"))
        ctx = app.state.ctx
        sid = archive.import_file(ctx, work.read_bytes())["id"]
        base = f"/sessions/{sid}"

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://snapshot") as http:

            async def take(url: str) -> dict | list | None:
                key = request_key(url)
                if key in entries:
                    return json.loads((snapshot / entries[key]).read_text(encoding="utf-8"))
                res = await http.get(f"/api{url}")
                if res.status_code != 200:
                    return None
                name = f"{len(entries) + 1}.json"
                (snapshot / name).write_text(res.text, encoding="utf-8")
                entries[key] = name
                return res.json()

            for url in ("/meta", "/providers", "/sessions", "/presets", "/appearance", "/fonts"):
                await take(url)
            for p in (await take("/presets"))["presets"]:
                await take(f"/presets/{quote(p['id'])}")

            for url in ("state", "conversations", "deleted", "runs/last", "usage", "tool-runs", "process-log"):
                await take(f"{base}/{url}")
            ws = await take(f"{base}/workspace")
            await take(f"{base}/events")
            for c in (await take(f"{base}/conversations"))["conversations"]:
                await take(f"{base}/workspace?conversation={quote(c['id'])}")
                await take(f"{base}/events?conversation={quote(c['id'])}")

            # 문서: 입력, 출력, 자료, 장면. 화면은 확장자를 붙인 경로로도 뗀 경로로도 묻는다.
            paths = ["입력", "출력", *(m["path"] for m in ws["materials"])]
            paths += [s["path"] for ch in ws["manuscript"]["chapters"] for s in ch["scenes"]]
            paths += [d["path"] for d in (await take(f"{base}/deleted"))["items"]]
            hashes: set[str] = set()
            for path in dict.fromkeys(paths):
                for form in dict.fromkeys((path, path.removesuffix(".md"))):
                    await take(f"{base}/docs/content?path={quote(form)}")
                    history = await take(f"{base}/docs/history?path={quote(form)}")
                    for entry in (history or {}).get("entries", []):
                        hashes.update(h for h in (entry.get("hash"), entry.get("prev_hash")) if h)
            for item in (await take(f"{base}/deleted"))["items"]:
                if item.get("hash"):
                    hashes.add(item["hash"])
            for h in sorted(hashes):
                await take(f"{base}/docs/version?hash={quote(h)}")

            # 글이 아닌 자료(이미지, PDF)는 파일 그대로 둔다.
            for m in ws["materials"]:
                if m.get("kind") == "text":
                    continue
                res = await http.get(f"/api{base}/files", params={"path": m["path"]})
                if res.status_code == 200:
                    name = f"files/{len(files) + 1}{Path(m['path']).suffix.lower()}"
                    (snapshot / name).write_bytes(res.content)
                    files[m["path"]] = name

        await ctx.runs.shutdown()

    (snapshot / "index.json").write_text(json.dumps({"entries": entries, "files": files}, ensure_ascii=False), encoding="utf-8")
    return len(entries), len(files)


def main() -> None:
    args = sys.argv[1:]
    out = REPO / "release" / "static-demo"
    if "--out" in args:
        i = args.index("--out")
        out = Path(args[i + 1]).resolve()
        del args[i:i + 2]
    work = next((Path(a).resolve() for a in args if not a.startswith("--")), DEMO_WORK)
    if not work.is_file():
        sys.exit(f"작업 파일을 찾지 못했습니다: {work}")
    if "--no-build" not in args:
        build_frontend(out)
    elif not (out / "index.html").exists():
        sys.exit(f"빌드된 화면이 없습니다: {out}")
    shutil.rmtree(out / "snapshot", ignore_errors=True)
    responses, files = asyncio.run(take_snapshot(work, out))
    (out / ".nojekyll").write_text("", encoding="utf-8")   # GitHub Pages가 파일을 가공하지 않고 그대로 내주게 한다
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1024
    print(f"{out}  (응답 {responses}개, 파일 {files}개, {size:,.0f} KB)")


if __name__ == "__main__":
    main()
