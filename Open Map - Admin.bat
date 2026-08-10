@echo off
REM Open the map with Admin Mode -- the private door -- and nothing else.
REM
REM The stack runs on the server and publishes everything on 127.0.0.1 there, so
REM the only way in is an SSH tunnel. Two listeners exist (see frontend/nginx.conf):
REM
REM   :80    what this opens. Admin Mode present, admin writes allowed.
REM   :8081  what the public Cloudflare link points at. Admin Mode is not even
REM          rendered there, and writes to /api/admin-config answer 403.
REM
REM So the gate on Admin Mode is possession of the server's SSH key, which is
REM also the gate on the server itself. Nothing new to remember.
REM
REM   "Open Map - Admin.bat"          -> tunnel up (if needed) and open the map
REM   "Open Map - Admin.bat" --close  -> tear the tunnel down
REM
REM Local ports are deliberately NOT 8080/3000. If the old local stack is ever
REM started again ("Run on This PC (legacy).bat"), it binds those, and the collision would either
REM fail confusingly or -- worse -- silently show you the local copy while you
REM believe you are editing the server's.
setlocal EnableDelayedExpansion

set SERVER=root@37.27.38.223
set LOCAL_APP=8090
set LOCAL_GRAFANA=3010
set WINDOW=osint-admin-tunnel

if /I "%~1"=="--close" goto close

REM ---- is a tunnel already up? -------------------------------------------
REM Checked by asking the port rather than by looking for an ssh process: there
REM may be other ssh sessions open for other reasons, and what matters here is
REM whether *this* forward is answering.
curl.exe -s -o NUL --max-time 3 http://localhost:%LOCAL_APP%/ 2>nul
if not errorlevel 1 (
    echo Tunnel already open on localhost:%LOCAL_APP%.
    goto launch
)

echo Opening SSH tunnel to %SERVER% ...
REM Its own titled, minimised window, exactly like "Run on This PC (legacy).bat"'s WSL keepalive:
REM the tunnel has to outlive this script, and a visible window is how you close
REM it later without hunting for a PID. -N because no remote command is wanted.
start "%WINDOW%" /min ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L %LOCAL_APP%:localhost:8080 -L %LOCAL_GRAFANA%:localhost:3000 %SERVER%

REM Poll rather than guess a sleep. The forward is usually answering in under
REM three seconds, but a cold DNS lookup or a slow link can take longer, and
REM opening the browser early just shows a connection error the reader then has
REM to refresh past.
set READY=
for /L %%t in (1,1,15) do (
    if "!READY!"=="" (
        call :wait2
        curl.exe -s -o NUL --max-time 3 http://localhost:%LOCAL_APP%/ 2>nul
        if not errorlevel 1 set READY=1
    )
)

if "!READY!"=="" (
    echo.
    echo The tunnel did not come up. Things worth checking, in order:
    echo   ssh %SERVER% "systemctl is-active docker"
    echo   ssh %SERVER% "cd /opt/osint ^&^& docker compose ps"
    echo   is port %LOCAL_APP% already taken by something else on this PC?
    echo.
    pause
    exit /b 1
)

:launch
REM Confirm which door this is before opening a browser on it. /public-mode
REM answers 404 on the private listener and {"readonly":true} on the public one,
REM so a 404 here is the proof that Admin Mode will actually be offered. If this
REM ever prints 200, the tunnel is pointed at 8081 by mistake and editing would
REM silently fail at save time.
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" --max-time 5 "http://localhost:%LOCAL_APP%/public-mode"`) do set MODE=%%c
if not "!MODE!"=="404" (
    echo.
    echo WARNING: /public-mode answered !MODE!, expected 404.
    echo          This tunnel is not pointed at the private listener -- Admin Mode
    echo          will be hidden and saves will be refused.
    echo.
)

echo.
echo   Map with Admin Mode:  http://localhost:%LOCAL_APP%
echo   Grafana:              http://localhost:%LOCAL_GRAFANA%
echo.
echo   Public read-only link: run "Show Public Link.bat"
echo.
echo The tunnel lives in the minimised "%WINDOW%" window. Closing that window --
echo or running "Open Map - Admin.bat" --close -- ends it. This window can be closed now.
start "" http://localhost:%LOCAL_APP%
exit /b 0

:close
echo Closing the tunnel ...
REM Match on the window title rather than the image name, so other ssh sessions
REM (including whatever you are reading this over) survive.
taskkill /FI "WINDOWTITLE eq %WINDOW%*" /IM ssh.exe /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq %WINDOW%*" /F >nul 2>&1
curl.exe -s -o NUL --max-time 3 http://localhost:%LOCAL_APP%/ 2>nul
if errorlevel 1 (echo Closed.) else (echo Still answering on %LOCAL_APP% -- another tunnel or the local stack is using it.)
exit /b 0

REM Roughly two seconds. `timeout /t` reads the console directly and aborts with
REM "Input redirection is not supported" whenever this script is run with its
REM output piped or captured; ping has no such opinion. Same reason as
REM update-link.bat's copy of this.
:wait2
ping -n 3 127.0.0.1 >nul 2>&1
goto :eof
