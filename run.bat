@echo off
setlocal
cd /d "%~dp0backend"
if not exist ".venv" (
  echo Run install.bat first.
  pause
  exit /b 1
)
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
set "PYTHONUTF8=1"
uv run --no-dev python -m aleph
if errorlevel 1 pause
