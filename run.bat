@echo off
REM Rebuilds the React frontend from source and starts the backend, which
REM serves that build (see backend/app.py). For active frontend development
REM with hot-reload instead of a rebuild-per-launch, run `npm run dev` in
REM frontend/ directly (its dev server proxies /api to this backend --
REM start `python -m backend.app` first, then `npm run dev` in another
REM terminal, and use the URL Vite prints instead of localhost:8000).
setlocal
cd /d "%~dp0"

if not exist ".venv" (
    echo Creating Python virtual environment...
    python -m venv .venv
)

call ".venv\Scripts\activate.bat"

echo Installing/updating dependencies...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt

if not exist ".env" (
    echo No .env file found -- creating one from .env.example.
    echo Edit .env in this folder to add your API keys, then run this again.
    copy ".env.example" ".env" >nul
)

echo Building the frontend (React + Vite)...
pushd frontend
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo npm install failed -- see above. Is Node.js installed?
    popd
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo Frontend build failed -- see above.
    popd
    pause
    exit /b 1
)
popd

echo Starting OSINT Live Globe... your browser will open automatically.
python -m backend.app

pause
