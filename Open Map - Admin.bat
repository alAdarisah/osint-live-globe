@echo off
REM Open the map with Admin Mode -- the private door -- and nothing else.
REM
REM The stack runs on the server and publishes everything on 127.0.0.1 there.
REM `tailscale serve` proxies those loopback ports onto the server's tailnet
REM address, so the private listener is reachable directly and no SSH tunnel is
REM needed. Two listeners exist (see frontend/nginx.conf):
REM
REM   :80    what this opens, via the tailnet. Admin Mode present, writes allowed.
REM   :8081  what the public Cloudflare link points at. Admin Mode is not even
REM          rendered there, and writes to /api/admin-config answer 403.
REM
REM The gate on Admin Mode is now being on the tailnet -- a device you approved
REM at login.tailscale.com -- rather than possession of the server's SSH key.
REM That is a deliberate trade and docs/security.md explains what it cost.
REM
REM Nothing is forwarded to a local port any more, so this can no longer collide
REM with the old local stack ("Run on This PC (legacy).bat") the way the 8090/3010
REM forwards were arranged to avoid.
setlocal EnableDelayedExpansion

REM The tailnet name, not the public address: port 22 and the served ports answer
REM only on the tailscale0 interface. See docs/security.md, "The tailnet".
set HOST=osint-server.tailee11c0.ts.net
set APP=http://%HOST%:8080
set GRAFANA=http://%HOST%:3000

if /I "%~1"=="--close" (
    echo Nothing to close -- this no longer opens a tunnel.
    echo The map is served over the tailnet at %APP%
    exit /b 0
)

REM ---- is the server reachable over the tailnet? --------------------------
REM Asking the app rather than pinging the host: Tailscale can be up while the
REM stack is down, and the two need different fixes.
curl.exe -s -o NUL --max-time 8 "%APP%/" 2>nul
if errorlevel 1 (
    echo.
    echo Could not reach %APP%
    echo.
    echo Things worth checking, in order:
    echo   is Tailscale running on this PC?  "%ProgramFiles%\Tailscale\tailscale.exe" status
    echo   is the server up?                 ssh root@%HOST% "cd /opt/osint ^&^& docker compose ps"
    echo   are the proxies still set?        ssh root@%HOST% "tailscale serve status"
    echo.
    pause
    exit /b 1
)

REM Confirm which door this is before opening a browser on it. /public-mode
REM answers 404 on the private listener and {"readonly":true} on the public one,
REM so a 404 here is the proof that Admin Mode will actually be offered. If this
REM ever prints 200, the proxy is pointed at 8081 by mistake and editing would
REM silently fail at save time.
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" --max-time 8 "%APP%/public-mode"`) do set MODE=%%c
if not "!MODE!"=="404" (
    echo.
    echo WARNING: /public-mode answered !MODE!, expected 404.
    echo          This is not the private listener -- Admin Mode will be hidden
    echo          and saves will be refused. Check: ssh root@%HOST% "tailscale serve status"
    echo.
)

echo.
echo   Map with Admin Mode:  %APP%
echo   Grafana:              %GRAFANA%
echo.
echo   Public read-only link: run "Show Public Link.bat"
echo.
echo No tunnel and no background window -- these are live for as long as
echo Tailscale is up on this PC. This window can be closed now.
start "" %APP%
exit /b 0
