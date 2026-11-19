@echo off
rem Development: backend with auto-reload on 8000, screen with hot reload on 5173.
setlocal
set "PYTHONUTF8=1"
start "ALEPH backend" cmd /k "cd /d ""%~dp0backend"" && uv run uvicorn aleph.app:create_app --factory --host 127.0.0.1 --port 8000 --reload"
start "ALEPH screen" cmd /k "cd /d ""%~dp0frontend"" && npm run dev"
echo Backend: http://127.0.0.1:8000    Screen (use this one): http://127.0.0.1:5173
