"""`python -m aleph` — 서버를 띄우고 브라우저를 연다.

이 컴퓨터에서만 접속할 수 있게 127.0.0.1에 연다. 8000번이 쓰이고 있으면
다음 빈 포트를 찾는다.

환경변수:
  ALEPH_PORT        쓸 포트를 직접 지정
  ALEPH_NO_BROWSER  1이면 브라우저를 자동으로 열지 않는다
"""

from __future__ import annotations

import os
import socket
import threading
import webbrowser

import uvicorn


def _free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def pick_port() -> int:
    wanted = os.environ.get("ALEPH_PORT")
    if wanted:
        return int(wanted)
    for port in range(8000, 8020):
        if _free(port):
            return port
    raise SystemExit("8000~8019번 포트가 모두 쓰이고 있습니다. ALEPH_PORT로 다른 포트를 지정해야 합니다.")


def main() -> None:
    from .settings import default_paths

    port = pick_port()
    url = f"http://127.0.0.1:{port}"
    paths = default_paths()
    print()
    print(f"  ALEPH  {url}")
    print(f"  데이터 폴더: {paths.data}")
    if not (paths.frontend_dist / "index.html").exists():
        print("  [주의] 화면 파일(frontend/dist)이 없습니다. install.bat을 다시 실행하거나 frontend에서 npm run build를 해야 합니다.")
    print("  끝내려면 이 창에서 Ctrl+C를 누르거나 창을 닫습니다.")
    print()
    if os.environ.get("ALEPH_NO_BROWSER") != "1":
        threading.Timer(1.5, webbrowser.open, args=[url]).start()
    uvicorn.run("aleph.app:create_app", factory=True, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
