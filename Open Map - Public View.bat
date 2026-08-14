@echo off
REM Open the map exactly as the public sees it.
REM
REM This is the counterpart to "Open Map - Admin.bat", and the difference is the
REM whole point of the two files existing:
REM
REM   Open Map - Admin.bat        SSH tunnel to the server's private listener.
REM                               Admin Mode present, edits save.
REM   Open Map - Public View.bat  the Cloudflare link anyone else gets. Admin
REM                               Mode is not rendered at all, and any attempt to
REM                               write the configuration answers 403.
REM
REM Use this before sharing the link, to see what a stranger will see. It is easy
REM to forget that your own browser has Admin Mode remembered in localStorage --
REM the public page ignores that, but only the public page proves it.
REM
REM No tunnel and no SSH forwarding: this is the real public URL over the
REM internet, so it also tells you the link is genuinely reachable from outside.
setlocal EnableDelayedExpansion

REM The tailnet name, not the public address: port 22 is firewalled to the
REM tailscale0 interface, so this resolves and connects only while Tailscale
REM is up on this PC. See docs/superpowers/specs/2026-08-14-tailscale-access-design.md
set SERVER=root@osint-server.tailee11c0.ts.net

echo Asking the server for the current public link...
REM The URL is not stored anywhere: it is a Cloudflare quick tunnel, so the
REM hostname is issued fresh whenever cloudflared restarts and only the server
REM knows the current one. `osint-link` reads it back out of the journal.
for /f "usebackq tokens=2 delims= " %%u in (`ssh %SERVER% "osint-link" ^| findstr /B "Link:"`) do set URL=%%u

if "!URL!"=="" (
    echo.
    echo Could not get the link. Check the tunnel:
    echo   ssh %SERVER% "systemctl status cloudflared"
    echo.
    pause
    exit /b 1
)

REM Confirm it really is the read-only door before opening a browser on it. The
REM marker answers {"readonly":true} on the public listener and 404 on the
REM private one, so a 404 here would mean the tunnel is pointed at the wrong port
REM and strangers can edit the map.
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" --max-time 20 "!URL!/public-mode"`) do set MODE=%%c
if not "!MODE!"=="200" (
    echo.
    echo WARNING: /public-mode answered !MODE!, expected 200.
    echo          This link may not be the read-only listener. Do not share it
    echo          until "Deploy Code to Server.bat" reports "admin write = 403".
    echo.
)

echo.
echo   Public link: !URL!
echo.
echo This is what anyone you share it with will see: the map, all read-only.
start "" "!URL!"
endlocal
