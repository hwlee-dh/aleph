@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   ALEPH - install
echo ============================================
echo.

where uv >nul 2>nul
if errorlevel 1 (
  echo "uv" was not found. uv is the tool that installs Python and the packages ALEPH needs.
  echo.
  choice /c YN /m "Install uv now from astral.sh (official installer)"
  if errorlevel 2 (
    echo.
    echo Install uv yourself, then run install.bat again:
    echo   https://docs.astral.sh/uv/getting-started/installation/
    pause
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
  where uv >nul 2>nul
  if errorlevel 1 (
    echo.
    echo uv was installed but this window cannot see it yet.
    echo Close this window and run install.bat again.
    pause
    exit /b 1
  )
)

echo [1/2] Installing backend packages...
cd /d "%~dp0backend"
uv sync --no-dev
if errorlevel 1 (
  echo.
  echo [ERROR] Backend install failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo [2/2] Checking the screen files...
cd /d "%~dp0"
if exist "frontend\dist\index.html" (
  echo Already built.
) else (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] frontend\dist is missing and Node.js is not installed.
    echo Get a release zip that includes the built screen, or install Node.js LTS
    echo from https://nodejs.org and run install.bat again.
    pause
    exit /b 1
  )
  cd /d "%~dp0frontend"
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
  call npm run build
  if errorlevel 1 ( echo [ERROR] Screen build failed. & pause & exit /b 1 )
)

cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul

echo.
echo ============================================
echo   Done. Double-click run.bat to start ALEPH.
echo   API keys: enter them in the Settings screen,
echo   or put them in the .env file in this folder.
echo ============================================
pause
