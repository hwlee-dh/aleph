"""배포 묶음이 빈 폴더에서 실제로 설치되고 도는지 본다.

    cd backend && uv run python ../scripts/check_release.py ../release/ALEPH-<날짜>.zip

zip을 임시 폴더에 풀고, install.bat이 하는 설치(uv sync --no-dev)를 한 뒤,
run.bat과 demo.bat이 하는 명령으로 서버를 띄워 화면 파일, 기본 프리셋, 가짜 모델 실행,
파일 올리기, 내보내기, 작업과 프리셋을 파일로 내보내고 다시 가져오기를 확인한다.
끝나면 임시 폴더를 지운다. 실제 모델은 부르지 않는다.
이미 풀어서 설치해 둔 폴더(…/ALEPH)를 줘도 된다.

이 컴퓨터에 uv와 Python, 내려받은 패키지가 이미 있으므로 "아무것도 없는 컴퓨터"의
확인은 아니다. 묶음에 빠진 파일이 없는지, 묶음만으로 도는지를 본다.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

target = Path(sys.argv[1]).resolve()
temp_dir: Path | None = None
if target.suffix == ".zip":
    temp_dir = Path(tempfile.mkdtemp(prefix="aleph-release-"))
    with zipfile.ZipFile(target) as z:
        z.extractall(temp_dir)
    app = temp_dir / "ALEPH"
    print(f"[설치] {app}")
    clean_env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    subprocess.run(["uv", "sync", "--no-dev"], cwd=app / "backend", check=True, env=clean_env)
else:
    app = target
    # 쓰던 폴더에 돌리면 그 폴더의 실제 데이터와 설정(진짜 모델)으로 서버가 뜬다. 그런 일이 없게 막는다.
    if (app / ".git").exists() or (app / "data").exists():
        raise SystemExit(
            "이 폴더는 이미 쓰던 폴더다 (.git이나 data/가 있다). 여기에 돌리면 실제 데이터에 작업이 생기고 "
            "설정된 진짜 모델로 요청이 나갈 수 있다. zip 파일을 주거나, 새로 풀어 설치만 한 폴더를 줘야 한다."
        )
backend = app / "backend"
env = {**os.environ, "PYTHONUTF8": "1", "ALEPH_NO_BROWSER": "1"}
env.pop("ALEPH_DATA_DIR", None)
env.pop("VIRTUAL_ENV", None)


def call(port: int, method: str, path: str, body=None, raw: bool = False):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode("utf-8")
            return (r.status, text) if raw else (r.status, json.loads(text))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def download(port: int, path: str) -> tuple[str, bytes]:
    """내려받는 파일의 (이름, 내용)."""
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=120) as r:
        disposition = r.headers.get("Content-Disposition", "")
        return urllib.parse.unquote(disposition.split("filename*=UTF-8''")[-1]), r.read()


def upload(port: int, path: str, data: bytes):
    """파일 바이트를 그대로 올린다."""
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def wait_up(port: int, proc: subprocess.Popen) -> None:
    for _ in range(120):
        if proc.poll() is not None:
            raise SystemExit(f"서버가 바로 죽었다 (exit {proc.returncode})")
        try:
            if call(port, "GET", "/api/health")[0] == 200:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit("서버가 뜨지 않았다")


def stop(proc: subprocess.Popen) -> None:
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


problems: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("  ok   " if ok else "  FAIL ") + what)
    if not ok:
        problems.append(what)


# --- 1. run.bat: 본 서버
print("[run.bat과 같은 명령]")
port = 8791
proc = subprocess.Popen(["uv", "run", "--no-dev", "python", "-m", "aleph"], cwd=backend, env={**env, "ALEPH_PORT": str(port)})
try:
    wait_up(port, proc)
    status, html = call(port, "GET", "/", raw=True)
    check(status == 200 and "<div id=\"root\">" in html, "화면(index.html)이 나온다")
    assets = [part.split('"')[0] for part in html.split('src="')[1:] + html.split('href="')[1:] if part.startswith("/assets/")]
    check(bool(assets) and all(call(port, "GET", a, raw=True)[0] == 200 for a in assets), f"화면 파일 {len(assets)}개가 모두 나온다")
    status, presets = call(port, "GET", "/api/presets")
    check("basic" in {p["id"] for p in presets["presets"]}, "기본 프리셋이 있다")
    status, p = call(port, "GET", "/api/presets/basic")
    names = [t["name"] for t in p["tools"]]
    check(names == ["compose", "critique", "summarize"] and all(t["prompt"].strip() for t in p["tools"]), "프리셋의 도구 파일(집필, 비평, 요약)이 들어 있다")
    check(p["model"] == "", "기본 프리셋은 모델을 비운 채 나간다")
    check(bool(p["instruction"].strip()) and len(p["starter"]) == 2, "프리셋의 지침과 시작 자료가 들어 있다")
    status, meta = call(port, "GET", "/api/meta")
    check(status == 200 and len(meta["modes"]) == 4, "제공자 종류와 모드 목록이 나온다")
    status, created = call(port, "POST", "/api/sessions", {"name": "설치 확인"})
    sid = created["id"]
    status, ws = call(port, "GET", f"/api/sessions/{sid}/workspace")
    check(len(ws["materials"]) == 2 and all(m["note"] for m in ws["materials"]), "새 작업에 시작 자료 2개가 노트로 깔린다")
    status, r = call(port, "POST", f"/api/sessions/{sid}/runs", {"goal": "써 줘"})
    check(status == 400 and "모델" in str(r), "모델을 안 골랐으면 읽을 수 있는 말로 막는다")
    check((app / "data").is_dir() and not (app / "data-demo").exists(), "데이터가 푼 폴더 안의 data/에 쌓인다")
finally:
    stop(proc)

# --- 2. demo.bat: 시연 서버 (가짜 모델로 처음부터 끝까지)
print("[demo.bat과 같은 명령, 브라우저 열기만 뺌]")
port = 8792
proc = subprocess.Popen(["uv", "run", "--no-dev", "python", "scripts/demo_server.py", str(port)], cwd=backend, env=env)
try:
    wait_up(port, proc)
    status, created = call(port, "POST", "/api/sessions", {"name": "시연 확인"})
    sid = created["id"]
    base = f"/api/sessions/{sid}"
    status, state = call(port, "PUT", f"{base}/state", {"mode": "autonomous"})
    check(status == 200 and state["effective_model"] == "demo:agent", "가짜 모델이 기본 모델로 잡혀 있다")
    status, r = call(port, "POST", f"{base}/runs", {"goal": "등대지기 딸 이야기를 두 장면으로 써 줘."})
    check(status == 200, "가짜 모델로 실행이 시작된다")
    status, stream = call(port, "GET", f"{base}/stream", raw=True)
    events = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
    check(bool(events) and events[-1].get("status") == "completed", "실행이 끝까지 돈다")
    errors = [e.get("result") for e in events if e["type"] == "tool_result" and not e.get("ok", True)]
    check(not errors, f"도구 오류가 없다 {errors[:2] if errors else ''}")
    status, ws = call(port, "GET", f"{base}/workspace")
    scenes = [s for c in ws["manuscript"]["chapters"] for s in c["scenes"]]
    check([s["number"] for s in scenes] == [1, 2] and all(s["chars"] > 100 for s in scenes), "원고에 두 장면이 순서대로 들어간다")
    check(all(s["summary_state"] == "ok" for s in scenes), "장면마다 요약이 붙는다 (에이전트가 요약 도구를 한꺼번에 돌린다)")
    check(all("max_tool_calls" not in e for e in events), "도구 호출 수에 한도가 없다")

    status, r = call(port, "POST", f"{base}/runs", {"goal": "서윤이 어떻게 그려지는지 원고를 훑어봐 줘."})
    status, stream = call(port, "GET", f"{base}/stream", raw=True)
    events = [json.loads(line[6:]) for line in stream.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
    explored = [e for e in events if e["type"] == "tool_result" and e.get("tool") == "explore"]
    check(events[-1].get("status") == "completed" and len(explored) == 1 and explored[0]["ok"], "읽기 에이전트가 돌고 답을 돌려준다")

    call(port, "PATCH", "/api/presets/basic", {"image_model": "demo:image"})
    status, r = call(port, "POST", f"{base}/runs", {"goal": "첫 장면의 삽화를 그려 줘."})
    call(port, "GET", f"{base}/stream", raw=True)
    status, ws = call(port, "GET", f"{base}/workspace")
    drawn = [m for m in ws["materials"] if m["kind"] == "image" and m["path"].startswith("자료/삽화/")]
    check(len(drawn) == 1 and drawn[0]["size"] > 200, "이미지 모델이 만든 그림이 자료에 들어간다")
    call(port, "PATCH", "/api/presets/basic", {"image_model": ""})

    status, made = call(port, "POST", f"{base}/conversations", {})
    status, r = call(port, "POST", f"{base}/runs", {"goal": "다음 장면도 써 줘."})
    call(port, "GET", f"{base}/stream", raw=True)
    status, listed = call(port, "GET", f"{base}/conversations")
    names = [(c["id"], c["name"]) for c in listed["conversations"]]
    check(names == [("main", "등대지기 딸 이야기를 두 장면으로 써 줘."), (made["id"], "다음 장면도 써 줘.")], "한 작업에 대화를 여럿 둘 수 있다")
    status, done = call(port, "POST", f"{base}/conversation/compact?conversation=main")
    check(status == 200 and done.get("compacted") is True and done["tokens_after"] < done["tokens_before"], "대화를 손으로 압축할 수 있다")
    status, ws = call(port, "GET", f"{base}/workspace")
    scenes = [s for c in ws["manuscript"]["chapters"] for s in c["scenes"]]
    check(len(scenes) == 3, "다른 대화에서 쓴 장면도 같은 원고에 들어간다")

    sample = backend / "scripts" / "시연용 글" / "등대지기의 딸.txt"
    check(sample.is_file(), "시연용 글이 묶음에 들어 있다")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{base}/upload?name={urllib.parse.quote(sample.name)}", data=sample.read_bytes(), method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        uploaded = json.loads(r.read().decode("utf-8"))
    check(uploaded["kind"] == "text" and uploaded["chars"] > 100, "글 파일을 올리면 글이 뽑혀 자료에 들어간다")
    status, r = call(port, "PUT", f"{base}/docs/content", {"path": "입력", "content": "@include:원고"})
    status, r = call(port, "POST", f"{base}/tools/compose/run")
    status, stream = call(port, "GET", f"{base}/stream", raw=True)
    check('"status": "completed"' in stream, "도구를 직접 돌릴 수 있다")
    status, body = call(port, "GET", f"{base}/export?format=html", raw=True)
    check(status == 200 and "<h1>시연 확인</h1>" in body, "원고를 내보낼 수 있다")
    status, log = call(port, "GET", f"{base}/process-log")
    check(status == 200 and "실행 종료 (완료)" in log["content"], "제작 기록이 나온다")
    check((app / "data-demo").is_dir(), "시연 데이터는 data-demo/에 따로 쌓인다")

    # 파일로 내보내고 다시 가져오기 (.aleph, .alephpreset)
    name, packed = download(port, f"{base}/archive")
    status, got = upload(port, "/api/import", packed)
    check(name == "시연 확인.aleph" and zipfile.is_zipfile(io.BytesIO(packed)), "작업을 .aleph 파일로 내보낸다")
    check(status == 200 and (got["kind"], got["name"]) == ("work", "시연 확인 (가져옴)"), "그 파일을 가져오면 새 작업으로 들어온다")
    status, ws = call(port, "GET", f"/api/sessions/{got['id']}/workspace")
    check([s["chars"] for c in ws["manuscript"]["chapters"] for s in c["scenes"]] == [s["chars"] for s in scenes], "가져온 작업에 원고가 그대로 있다")
    name, packed = download(port, "/api/presets/basic/archive")
    status, got = upload(port, "/api/import", packed)
    check(name == "기본.alephpreset", "프리셋을 .alephpreset 파일로 내보낸다")
    check(status == 200 and got["kind"] == "preset" and len(got["preset"]["tools"]) == 3 and got["preset"]["id"] != "basic", "그 파일을 가져오면 새 프리셋으로 들어온다")
    status, r = upload(port, "/api/import", b"not an aleph file")
    check(status == 400 and "ALEPH" in str(r), "다른 파일은 이유와 함께 거절한다")
finally:
    stop(proc)

if temp_dir is not None:
    shutil.rmtree(temp_dir, ignore_errors=True)
print()
print("문제 없음" if not problems else f"문제 {len(problems)}건: " + " / ".join(problems))
sys.exit(1 if problems else 0)
