@echo off
REM Pull the newest server-side database dumps down to this PC.
REM
REM Why this exists: the server's nightly dumps (see /opt/osint/backup.sh, run by
REM osint-backup.timer at 03:18 UTC) land on /var/backups/osint -- which is the
REM same /dev/sda1 as the database itself. That protects against a dropped table
REM or a bad migration, but not against losing the volume. Hetzner's snapshot
REM backups cover that case; this covers it a second way, for free, by keeping
REM copies somewhere the server cannot take with it.
REM
REM What it pulls: the three newest dumps. Each is ~18 MB and contains
REM conflict_events, source_health, alerts and reference_snapshots -- the tables
REM that cannot be re-collected. entity_history and entity_latest are
REM deliberately not in them; those refill from live polling within a day.
REM
REM Run it whenever, or schedule it: Task Scheduler -> Create Basic Task ->
REM Daily -> Start a program -> this file. It needs no arguments and no
REM credentials beyond the SSH key already in %USERPROFILE%\.ssh.
setlocal

set SERVER=root@37.27.38.223
set REMOTE=/var/backups/osint
set DEST=%~dp0data\backups
set KEEP_DAYS=30

if not exist "%DEST%" mkdir "%DEST%"

echo Pulling newest dumps from %SERVER% ...
for /f "delims=" %%f in ('ssh %SERVER% "ls -1t %REMOTE%/*.sql.gz 2>/dev/null ^| head -3"') do (
    if not exist "%DEST%\%%~nxf" (
        echo   fetching %%~nxf
        REM No trailing backslash before the closing quote: it escapes the quote
        REM and scp ends up with a directory name containing it.
        scp %SERVER%:"%%f" "%DEST%"
    ) else (
        echo   already have %%~nxf
    )
)

REM Local retention. Longer than the server's 14 nights on purpose: this copy is
REM the one that survives the server, so it is worth keeping further back.
forfiles /p "%DEST%" /m *.sql.gz /d -%KEEP_DAYS% /c "cmd /c echo   pruning @file & del @path" 2>nul

echo.
echo Local copies in %DEST%:
dir /b /o-d "%DEST%\*.sql.gz" 2>nul || echo   (none -- something went wrong)
echo.
echo Restore one with:
echo   zcat FILE.sql.gz ^| docker compose exec -T postgres psql -U osint -d osint
endlocal
