@echo off
REM Opens the command center (ops/cc) on the stack running on THIS PC, and
REM changes nothing by itself: it reads container state, source production,
REM database health and the live log, and waits for you to press a key.
REM
REM The name says "This PC" because the command center's real home is the
REM server, where it is `cc` with no arguments:
REM
REM   ssh root@osint-server.tailee11c0.ts.net -t cc          (after ./ops/cc/install.sh /opt/osint)
REM
REM Same program, same keys, different stack. Watching the wrong one is the
REM mistake this name exists to prevent -- the panes look identical, and
REM "ingest is up" is a different claim about each.
REM
REM Docker lives inside the WSL distro "archlinux" on this machine, not in
REM Docker Desktop on Windows, so the command center runs there too. A
REM Windows-side copy can reach the API but never `docker compose`, which
REM would leave the SERVICES pane permanently empty.
REM
REM Flags are passed through:  "Watch the Stack - This PC.bat" --read-only
REM   --read-only   disable every key that starts, stops or deploys
REM   --light       for a light terminal profile
setlocal

set DISTRO=archlinux
set REPO=/mnt/c/Users/theis/Desktop/Claude Workspace/OSINT
set VENV=$HOME/.venvs/cc

REM ---- the venv the command center runs in --------------------------------
REM Its own, not the backend's: the pins differ (see ops/cc/requirements.txt)
REM and nothing here shares a process with the app. Created on first run so
REM this script works on a machine that has never opened it.
wsl -d %DISTRO% -e sh -lc "test -x %VENV%/bin/python" >nul 2>&1
if errorlevel 1 (
    echo First run -- creating the command center's virtualenv in WSL...
    wsl -d %DISTRO% -e sh -lc "python3 -m venv %VENV% && %VENV%/bin/pip install -q -r '%REPO%/ops/cc/requirements.txt'"
    if errorlevel 1 (
        echo.
        echo Could not build the virtualenv. Needed: python and the venv module
        echo inside the distro.
        echo   wsl -d %DISTRO% -e sh -lc "python3 -m venv --help"
        echo.
        pause
        exit /b 1
    )
)

REM ---- warn, but do not start anything -----------------------------------
REM Starting the daemon here would make this script one that changes the
REM machine, which is exactly what a watcher must not be. It is worth saying
REM out loud though: with the daemon down the SERVICES pane dims and `s` has
REM nothing to talk to, which reads like the command center is broken.
wsl -d %DISTRO% -e sh -lc "systemctl is-active --quiet docker"
if errorlevel 1 (
    echo.
    echo NOTE: the Docker daemon is not running in %DISTRO%, so the SERVICES
    echo       pane will be dim and the start/stop keys will fail. Start it with
    echo       "Run on This PC (legacy).bat", or:
    echo         wsl -d %DISTRO% -e sh -lc "systemctl start docker"
    echo.
)

REM ---- launch -------------------------------------------------------------
REM Windows Terminal when it is there: the command center is a full-screen TUI
REM with box drawing and 24-bit colour, and the old console host renders both
REM badly. Falling back to running in place rather than refusing, because a
REM degraded dashboard still beats no dashboard.
where wt.exe >nul 2>&1
if errorlevel 1 (
    wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && %VENV%/bin/python -m ops.cc --compose-dir . %*"
    exit /b 0
)

start "" wt.exe new-tab --title "osint command center" wsl.exe -d %DISTRO% -e sh -lc "cd '%REPO%' && %VENV%/bin/python -m ops.cc --compose-dir . %*"
exit /b 0
