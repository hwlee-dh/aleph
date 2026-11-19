"""배포용 zip을 만든다 — 받는 사람은 Node 없이 install.bat → run.bat만 하면 된다.

    cd backend && uv run python ../scripts/make_release.py [--no-build]

하는 일: 화면을 빌드하고(frontend/dist), 실행에 필요한 파일만 골라
release/ALEPH-<날짜>.zip으로 묶는다. 작업 데이터(data/), 키(.env), 개발용 파일은
들어가지 않는다.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

INCLUDE_FILES = ["install.bat", "run.bat", "demo.bat", ".env.example", "README.md", "LICENSE", "backend/pyproject.toml", "backend/uv.lock"]
INCLUDE_DIRS = ["backend/aleph", "backend/presets", "backend/scripts", "frontend/dist"]
SKIP_PARTS = {"__pycache__", ".pytest_cache"}


def build_frontend() -> None:
    npm = shutil.which("npm")
    if npm is None:
        sys.exit("npm이 없다. 화면을 빌드하려면 Node.js가 필요하다.")
    frontend = REPO / "frontend"
    if not (frontend / "node_modules").exists():
        subprocess.run([npm, "install"], cwd=frontend, check=True)
    subprocess.run([npm, "run", "build"], cwd=frontend, check=True)


def main() -> None:
    if "--no-build" not in sys.argv:   # 이미 빌드해 둔 화면(frontend/dist)을 그대로 묶을 때
        build_frontend()
    out_dir = REPO / "release"
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"ALEPH-{date.today():%Y%m%d}.zip"
    count = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in INCLUDE_FILES:
            z.write(REPO / rel, f"ALEPH/{rel}")
            count += 1
        for rel in INCLUDE_DIRS:
            for path in sorted((REPO / rel).rglob("*")):
                if path.is_file() and not (SKIP_PARTS & set(path.parts)) and path.suffix != ".pyc":
                    z.write(path, f"ALEPH/{path.relative_to(REPO).as_posix()}")
                    count += 1
    print(f"{target}  ({count}개 파일, {target.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
