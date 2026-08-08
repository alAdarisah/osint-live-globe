@echo off
REM Rebuilds whatever the shared link is serving stale, and prints the link.
REM
REM The Cloudflare tunnel is a dumb pipe to host port 8080 -- it always shows
REM whatever nginx is serving *right now*, so "the link is out of date" is never
REM a tunnel problem. It means the frontend image was built before the source
REM was last edited. That is the whole job here: compare each image's build time
REM against the mtime of the files that go into it, rebuild only what is behind,
REM and leave everything else running.
REM
REM   update-link.bat            -> backend + frontend if stale, ingest reported
REM   update-link.bat --ingest   -> also rebuild ingest (see the warning below)
REM   update-link.bat --force    -> rebuild backend + frontend regardless
REM
REM ingest is opt-in on purpose. It owns every credentialed and metered source
REM (ACLED, FIRMS, ADS-B, AIS, Overpass) and re-polls on start, so a rebuild
REM costs real quota. Nothing it does is visible in the bundle the link serves,
REM so the default path never touches it -- but it is still *reported* as stale,
REM because a collector silently running month-old code is worth knowing about.
REM
REM refine and cache-worker are deliberately absent. They hold no credentials
REM and serve no HTTP, so nothing about the link depends on their code; rebuild
REM them by hand when their behaviour is what changed.
REM
REM Assumes the stack is already up (run-stack.bat). Compose starts the
REM dependencies anyway, so running this on a cold machine works -- it is just
REM slower than saying so.
setlocal EnableDelayedExpansion

set DISTRO=archlinux
set REPO=/mnt/c/Users/theis/Desktop/Claude Workspace/OSINT
set CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe
REM Under data/, which is gitignored except for its README -- this is a runtime
REM artefact, and the URL in it changes on every tunnel restart.
set TUNNEL_LOG=%~dp0data\cloudflared.log
set WSL_TUNNEL_LOG=%REPO%/data/cloudflared.log

set REBUILD_INGEST=0
set FORCE=0
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--ingest" set REBUILD_INGEST=1
if /I "%~1"=="--force" set FORCE=1
shift
goto parse_args
:args_done

REM Same two preconditions as run-stack.bat, and idempotent: Windows only
REM reaches the published ports while a WSL session is attached, and the daemon
REM does not start itself if the distro was booted without one.
wsl -d %DISTRO% -e pgrep -f "sleep infinity" >nul 2>&1
if errorlevel 1 (
    echo Pinning a WSL session open so localhost keeps forwarding...
    start "wsl-keepalive" /min wsl.exe -d %DISTRO% -e sh -c "sleep infinity"
)
wsl -d %DISTRO% -e sh -lc "systemctl is-active --quiet docker || systemctl start docker"
if errorlevel 1 (
    echo Could not start the Docker daemon in WSL. Is the distro healthy?
    pause
    exit /b 1
)

echo.
echo Checking which images are behind their source...
call :staleness osint-backend  "backend requirements.txt"                                                      STATE_BACKEND
call :staleness osint-frontend "frontend/src frontend/index.html frontend/package.json frontend/nginx.conf frontend/Dockerfile" STATE_FRONTEND
call :staleness osint-ingest   "backend requirements.txt"                                                      STATE_INGEST

if "%FORCE%"=="1" (
    set STATE_BACKEND=STALE
    set STATE_FRONTEND=STALE
    echo   --force given, rebuilding backend and frontend regardless.
)

echo   backend  !STATE_BACKEND!
echo   frontend !STATE_FRONTEND!
echo   ingest   !STATE_INGEST!

set SERVICES=
if "!STATE_BACKEND!"=="STALE"  set SERVICES=!SERVICES! backend
if "!STATE_FRONTEND!"=="STALE" set SERVICES=!SERVICES! frontend
if "%REBUILD_INGEST%"=="1"     set SERVICES=!SERVICES! ingest

if "!SERVICES!"=="" (
    echo.
    echo Nothing to rebuild -- every image is newer than its source.
) else (
    echo.
    echo Rebuilding:!SERVICES!
    wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && docker compose up -d --build !SERVICES!"
    if errorlevel 1 (
        echo.
        echo Compose failed -- see above. The link keeps serving the previous build.
        pause
        exit /b 1
    )
)

if "!STATE_INGEST!"=="STALE" if "%REBUILD_INGEST%"=="0" (
    echo.
    echo Note: ingest is running code older than backend/. Not rebuilt, because
    echo       restarting it re-polls every metered source. Run with --ingest
    echo       when that is what you actually want.
)

REM ---- the tunnel -------------------------------------------------------
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if errorlevel 1 (
    echo.
    echo No tunnel running. Starting one...
    if not exist "%CLOUDFLARED%" (
        echo cloudflared not found at "%CLOUDFLARED%".
        pause
        exit /b 1
    )
    REM Truncate first: the URL is grepped back out of this file below, and a
    REM stale line from a previous tunnel would be indistinguishable from the
    REM live one.
    type nul > "%TUNNEL_LOG%"
    REM cloudflared's own --logfile rather than a shell redirect. `start ... cmd
    REM /c "..." > "..."` needs nested quotes that cmd mis-parses, and because
    REM batch parses a whole parenthesised block before running it, that error
    REM killed the script even on the branch where no tunnel needed starting.
    start "cloudflared-tunnel" /min "%CLOUDFLARED%" tunnel --no-autoupdate --url http://localhost:8080 --logfile "%TUNNEL_LOG%"
    set STARTED_TUNNEL=1
    REM Quick tunnels take a few seconds to be issued a hostname; poll rather
    REM than guess a sleep long enough for the worst case. Note that the
    REM hostname appearing in the log is not the same as it being resolvable --
    REM that is what the longer probe budget further down is for.
    for /L %%t in (1,1,20) do (
        if "!URL!"=="" (
            call :wait2
            call :read_url URL
        )
    )
) else (
    call :read_url URL
)

echo.
if "!URL!"=="" (
    echo A cloudflared process is running but no URL could be read from
    echo   %TUNNEL_LOG%
    echo That happens when the tunnel was started outside this script -- its
    echo output went somewhere else. The rebuild above is live either way; to get
    echo the URL printed here, stop it and rerun:
    echo.
    echo   taskkill /IM cloudflared.exe /F ^&^& update-link.bat
    echo.
    echo Note that a new tunnel gets a NEW address -- reshare it.
    goto :end
)

REM ---- proof it actually works ------------------------------------------
REM Retried, not probed once. `compose up` returns when the container has been
REM *started*, and nginx binds a moment after that -- so a single immediate
REM request races the thing it is testing and reports 502 on a rebuild that
REM worked perfectly. Three runs in a row cried wolf that way. A real failure
REM still shows up: it just takes longer to say so.
REM
REM Two different races, two different budgets. A rebuilt container is listening
REM within a couple of seconds. A tunnel issued seconds ago is a brand new DNS
REM name, and until it propagates the request fails to connect outright -- curl
REM reports 000, not 502, and 12 seconds was not close to enough. So when this
REM run started the tunnel, wait considerably longer before calling it broken.
set CODE_ROOT=
set PROBES=6
if "!STARTED_TUNNEL!"=="1" set PROBES=30
for /L %%t in (1,1,!PROBES!) do (
    if not "!CODE_ROOT!"=="200" (
        for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" --max-time 25 "!URL!"`) do set CODE_ROOT=%%c
        if not "!CODE_ROOT!"=="200" call :wait2
    )
)
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" --max-time 25 "!URL!/api/health"`) do set CODE_API=%%c
REM Read the bundle name out of the running container rather than off the page:
REM it is the one thing that proves the *new* build is what is being served.
for /f "usebackq delims=" %%b in (`wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && docker compose exec -T frontend sh -c 'ls /usr/share/nginx/html/assets/index-*.js 2>/dev/null | head -1 | xargs -r basename'"`) do set BUNDLE=%%b

echo Link:    !URL!
echo Bundle:  !BUNDLE!
echo Status:  /  = !CODE_ROOT!    /api/health = !CODE_API!
if not "!CODE_ROOT!"=="200" echo   WARNING: the page is not answering 200 -- is the frontend container up?
if not "!CODE_API!"=="200"  echo   WARNING: the API is not answering 200 -- check: docker compose logs backend
echo.
echo Anyone opening the link already has it cached; tell them Ctrl+Shift+R.

:end
echo.
endlocal
exit /b 0

REM Roughly two seconds. `timeout /t` would be the obvious call and is what was
REM here first, but it reads the console directly and aborts with "Input
REM redirection is not supported" the moment the script is run with its output
REM piped or captured -- which is exactly how it gets run from a terminal that
REM is logging. ping has no such opinion: three packets to loopback, one second
REM apart, is two seconds of waiting anywhere.
:wait2
ping -n 3 127.0.0.1 >nul 2>&1
goto :eof

REM Sets %3 to STALE or FRESH by comparing an image's build time against the
REM mtime of the paths in %2. A missing image reports as built at the epoch, so
REM "never built" and "built too long ago" take the same branch instead of
REM needing their own error path.
:staleness
setlocal
set IMG=%~1
set SRC=%~2
for /f "usebackq delims=" %%r in (`wsl -d %DISTRO% -e sh -lc "cd '%REPO%' && c=$(docker image inspect %IMG% --format {{.Created}} 2>/dev/null || echo 1970-01-01T00:00:00Z); e=$(date -d $c +%%s); n=$(find %SRC% -type f -newermt @$e -not -path '*/node_modules/*' -not -path '*/__pycache__/*' 2>/dev/null | wc -l); [ $n -gt 0 ] && echo STALE || echo FRESH"`) do set RESULT=%%r
endlocal & set "%~3=%RESULT%"
goto :eof

REM Last URL in the tunnel log. grep runs in the distro because findstr has no
REM way to print just the match.
:read_url
setlocal
set FOUND=
for /f "usebackq delims=" %%u in (`wsl -d %DISTRO% -e sh -lc "grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' '%WSL_TUNNEL_LOG%' 2>/dev/null | tail -1"`) do set FOUND=%%u
endlocal & set "%~1=%FOUND%"
goto :eof
