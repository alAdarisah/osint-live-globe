@echo off
REM Print the current public link to the map, and check that it answers.
REM
REM Replaces the tunnel half of update-link.bat. That script ran cloudflared on
REM *this PC* against the local stack; both now live on the server, so there is
REM nothing here to rebuild and nothing here to tunnel -- only a URL to ask for.
REM
REM The link is a Cloudflare quick tunnel, which means Cloudflare issues the
REM hostname when cloudflared starts and a NEW one after every restart, including
REM after a server reboot. So this is the thing to run before sharing, every
REM time. A permanent address needs a domain on a Cloudflare account and a named
REM tunnel; nothing else about the setup would change.
REM
REM What the link serves is the read-only listener (nginx :8081): the map, all
REM read endpoints, and a 403 on any attempt to write the admin configuration.
REM Full access with the admin panel is the SSH tunnel instead:
REM
REM   ssh -L 8080:localhost:8080 root@osint-server.tailee11c0.ts.net     then http://localhost:8080
setlocal

REM The tailnet name, not the public address: port 22 is firewalled to the
REM tailscale0 interface, so this resolves and connects only while Tailscale
REM is up on this PC. See docs/superpowers/specs/2026-08-14-tailscale-access-design.md
set SERVER=root@osint-server.tailee11c0.ts.net

ssh %SERVER% "osint-link"
if errorlevel 1 (
    echo.
    echo Could not read the link. Check the tunnel:
    echo   ssh %SERVER% "systemctl status cloudflared"
)

echo.
echo Anyone who opened a previous link has it cached; tell them Ctrl+Shift+R.
endlocal
