@echo off
REM Push this working tree to the server and rebuild whatever is behind it.
REM
REM Replaces update-link.bat, which assumed the source and Docker were on the
REM same machine. They no longer are: you edit here, the stack runs on the
REM server, so a deploy is now two steps -- sync, then rebuild -- and the second
REM half lives in deploy.sh where it can be written in bash instead of batch.
REM
REM   "Deploy Code to Server.bat"            sync, then rebuild backend/frontend/refine/cache-worker if stale
REM   "Deploy Code to Server.bat" --ingest   also rebuild ingest -- it re-polls every metered source on start
REM   "Deploy Code to Server.bat" --force    rebuild regardless of staleness
REM
REM What is synced: the files that go into images, and docker-compose.yml. Not
REM data/ -- that is runtime state on both machines and the server's copy is the
REM live one -- and not .git, node_modules, dist or __pycache__.
REM
REM Deliberately NOT a git pull on the server. The repo has uncommitted work in
REM it most of the time, and a deploy that only shipped committed changes would
REM be a deploy that silently omitted whatever you were actually testing.
setlocal EnableDelayedExpansion

REM The tailnet name, not the public address: port 22 is firewalled to the
REM tailscale0 interface, so this resolves and connects only while Tailscale
REM is up on this PC. See docs/superpowers/specs/2026-08-14-tailscale-access-design.md
set SERVER=root@osint-server.tailee11c0.ts.net
set REMOTE=/opt/osint
set TARBALL=%TEMP%\osint-deploy.tgz

echo Packing the working tree...
REM tar ships with Windows 11. --exclude before the paths, and forward slashes,
REM because this is bsdtar and it is happier that way.
tar -czf "%TARBALL%" ^
    --exclude=node_modules --exclude=__pycache__ --exclude=*.pyc ^
    --exclude=dist --exclude=.pytest_cache ^
    backend frontend requirements.txt docker-compose.yml deploy.sh
if errorlevel 1 (
    echo Could not pack the tree. Are you running this from the repo root?
    pause
    exit /b 1
)

for %%s in ("%TARBALL%") do echo   %%~zs bytes

echo Uploading to %SERVER%...
scp "%TARBALL%" %SERVER%:/root/osint-deploy.tgz
if errorlevel 1 (
    echo Upload failed. Check: ssh %SERVER% "echo ok"
    pause
    exit /b 1
)
del "%TARBALL%" >nul 2>&1

echo Extracting and rebuilding...
echo.
REM sed strips CRLF from deploy.sh: it is edited on Windows, and bash treats a
REM trailing carriage return as part of the command name.
ssh %SERVER% "tar -xzf /root/osint-deploy.tgz -C %REMOTE% && rm /root/osint-deploy.tgz && sed -i 's/\r$//' %REMOTE%/deploy.sh && chmod +x %REMOTE%/deploy.sh && %REMOTE%/deploy.sh %*"
if errorlevel 1 (
    echo.
    echo The remote build reported a failure -- see above. Whatever was running
    echo before is still running; a failed build does not replace a good container.
    pause
    exit /b 1
)

echo.
echo Public link:
ssh %SERVER% "osint-link"
echo.
echo Admin view: run "Open Map - Admin.bat"   (http://osint-server.tailee11c0.ts.net:8080)
echo.
echo Anyone holding the public link has the old bundle cached; tell them Ctrl+Shift+R.
endlocal
