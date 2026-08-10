@echo off
REM Starts the Docker Compose stack -- Postgres on a named volume, the ingest
REM process, the FastAPI backend, and the React app behind nginx -- and opens
REM the map. This is the only supported way to run the app: the containers keep
REM collecting with no browser open, and Postgres (volume osint_pgdata) survives
REM restarts and reboots, so the GDELT conflict window and the fused-event
REM history are rehydrated at startup instead of beginning empty.
REM
REM For frontend work, run `python -m backend.app` and `npm run dev` directly.
REM That serves only the sources the backend still polls itself -- ships,
REM aircraft, fires, conflict events and OSM infrastructure come through the
REM ingest process (`python -m backend.ingest`), which needs a reachable
REM DATABASE_URL.
REM
REM Docker lives inside the WSL distro "archlinux" on this machine, not in
REM Docker Desktop on Windows, so every compose command is forwarded there.
REM The repo is reached through /mnt/c. Windows can talk to the published
REM ports on localhost (8080 frontend, 8000 backend API, 5432 Postgres).
REM
REM Two machine-level settings make the stack survive on its own; if the map
REM ever goes cold, check them first:
REM   * docker.service is enabled in the distro (systemctl enable docker), so
REM     the daemon and the containers come back whenever the distro boots.
REM   * vmIdleTimeout=-1 in %USERPROFILE%\.wslconfig keeps the WSL VM alive
REM     with no session attached. Without it the VM shuts down about a minute
REM     after the last shell closes and takes the collectors with it.
setlocal

set DISTRO=archlinux
set REPO=/mnt/c/Users/theis/Desktop/Claude Workspace/OSINT

REM Windows reaches the containers at localhost only while a WSL session is
REM attached: with none, the relay stops forwarding even though the VM and the
REM containers are still running, and localhost:8080 starts refusing. So hold
REM one open. It is a single sleeping process, and it exits with `wsl
REM --shutdown` like everything else in the distro.
wsl -d %DISTRO% -e pgrep -f "sleep infinity" >nul 2>&1
if errorlevel 1 (
    echo Pinning a WSL session open so localhost keeps forwarding...
    start "wsl-keepalive" /min wsl.exe -d %DISTRO% -e sh -c "sleep infinity"
)

echo Starting the Docker daemon in WSL (%DISTRO%)...
wsl -d %DISTRO% -e sh -lc "systemctl is-active --quiet docker || systemctl start docker"
if errorlevel 1 (
    echo Could not start the Docker daemon in WSL. Is the distro healthy?
    echo Try: wsl -d %DISTRO% -e sh -lc "systemctl status docker"
    pause
    exit /b 1
)

REM Pass --build (or any other compose flag) through to this script when the
REM images need rebuilding after a code change:  "Run on This PC (legacy).bat" --build
echo Bringing up the stack...
wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && docker compose up -d %*"
if errorlevel 1 (
    echo Compose failed -- see above.
    echo Logs: wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && docker compose logs backend"
    pause
    exit /b 1
)

echo.
wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && docker compose ps"
echo.
echo Map: http://localhost:8080   API: http://localhost:8000
start "" http://localhost:8080
