@echo off
setlocal EnableExtensions
title Chalkle keeper
set "ROOT=%~dp0.."
cd /d "%ROOT%"

rem =====================================================================
rem  Chalkle keeper: keeps the local site + Cloudflare tunnel alive.
rem  Run once at logon (or from Task Scheduler). Restarts anything that
rem  dies, so lootline.xyz stays up as long as this PC is on.
rem  All children are launched HIDDEN (no taskbar windows) with logs
rem  redirected to files: chalkle-server.log, chalkle-music.log,
rem  chalkle-named-tunnel.log.
rem
rem  PID files (items 437/492/610/691): every service the keeper starts
rem  records its child PID in chalkle-pids\<name>.pid. Before starting a
rem  service again the keeper kills the recorded PID, but only when that
rem  PID is still alive AND still runs the expected image, so a reused
rem  PID can never make the keeper kill an unrelated process. This is
rem  what stopped the orphan node.exe pileup from health-check restarts.
rem
rem  Single instance: two keeper loops fight over the same services
rem  (double music restarts made the node orphans, seen 09/13). Before the
rem  loop starts, scripts/keeper-singleton.ps1 counts other cmd processes
rem  whose command line mentions start-chalkle.bat; if one exists, this
rem  copy exits instead of becoming a second fighter.
rem =====================================================================

set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"
set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=cloudflared"
set "TUNNEL_ID=4b871657-7390-4c4a-b6b1-a51f9710a2de"
set "LOG=%ROOT%\keeper.log"
set "PIDS=%ROOT%\chalkle-pids"
if not exist "%PIDS%" mkdir "%PIDS%" >nul 2>&1
rem ---- pinned system tools: never trust PATH for these. A bash-style
rem PATH exports GNU find as find, whose /I flag errors and silently
rem flips every errorlevel check in this file (seen 09/14). ----
set "TL=%SystemRoot%\System32\tasklist.exe"
set "TK=%SystemRoot%\System32\taskkill.exe"
set "FNDF=%SystemRoot%\System32\find.exe"
set "CURL=%SystemRoot%\System32\curl.exe"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

rem ---- single-instance guard (see header note) ----
rem PowerShell counts every OTHER cmd whose command line mentions
rem start-chalkle.bat. The caller itself is excluded by parent PID, which
rem a command-line match inside the bat could never do (its own command
rem line always contains the script path).
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\keeper-singleton.ps1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] another keeper is already running, this copy exits >> "%LOG%"
  exit /b 0
)

rem ---- Cloudflare R2 (chat image uploads). Optional: without these the
rem      chat upload endpoint answers 503 and chat falls back to inline
rem      base64 images. Fill in from Cloudflare Dashboard > R2. ----
set "R2_ACCOUNT_ID="
set "R2_ACCESS_KEY_ID="
set "R2_SECRET_ACCESS_KEY="
set "R2_BUCKET="
set "R2_PUBLIC_BASE="

echo [%date% %time%] Chalkle keeper starting >> "%LOG%"

:LOOP
call :check_server
call :check_music
call :check_cloud
call :check_bitcord
call :check_esm
call :check_tunnel
ping -n 21 127.0.0.1 >nul 2>&1
goto LOOP

rem ---- kill_stale <name> <image> ----
rem Kills the process recorded in chalkle-pids\<name>.pid, but only when
rem that PID is still alive AND still runs <image>. No parentheses blocks
rem here on purpose: %KPID% would expand before the set /p inside them.
:kill_stale
set "KPID="
if exist "%PIDS%\%~1.pid" set /p KPID=<"%PIDS%\%~1.pid" 2>nul
if not defined KPID goto :eof
set "KIMG=%~2"
"%TL%" /FI "PID eq %KPID%" /FI "IMAGENAME eq %KIMG%" 2>nul | "%FNDF%" /I "%KIMG%" >nul
if errorlevel 1 goto kill_stale_drop
echo [%date% %time%] killing stale %~1 process %KPID% before restart >> "%LOG%"
"%TK%" /PID %KPID% /F >nul 2>&1
ping -n 2 127.0.0.1 >nul 2>&1
:kill_stale_drop
del "%PIDS%\%~1.pid" >nul 2>&1
goto :eof

rem ---- server on :4173 ----
:check_server
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:4173/ > "%TEMP%\ck-srv.txt" 2>nul
set /p srv=<"%TEMP%\ck-srv.txt"
if "%srv%"=="200" goto :eof
rem Crash-loop guard: if we just started it within the last minute, do not
rem pile up a second copy while the first one is still binding the port.
rem Two pythons on one port = the second dies with Address already in use
rem and the log fills with "down, starting" every cycle (seen 09/13).
if "%srv%"=="000" goto server_start
rem Port answered with something other than 200 (403/404/500): the server
rem IS running, the check URL just failed. Log it, do not start a dupe.
echo [%date% %time%] server answered %srv% (not 200), leaving it alone >> "%LOG%"
goto :eof
:server_start
echo [%date% %time%] server down (was 000), starting >> "%LOG%"
rem Double-quoted argument: Start-Process does not quote array items that
rem contain spaces on its own, and %~dp0 has spaces, so embed the quotes.
rem -PassThru writes the child PID so the next restart can kill it first.
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath '%PY%' -ArgumentList @('""%ROOT%\server\serve-chalk.py""') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-server.log' -RedirectStandardError '%ROOT%\chalkle-server-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\server.pid' -Value $p.Id"
goto :eof

rem ---- music backend on :3004 (node, needed for the Music tab) ----
:check_music
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:3004/health > "%TEMP%\ck-mus.txt" 2>nul
set /p mus=<"%TEMP%\ck-mus.txt"
if "%mus%"=="200" goto :eof
if not "%mus%"=="000" if not "%mus%"=="" goto music_sick
echo [%date% %time%] music backend down, cleaning stale then starting >> "%LOG%"
call :kill_stale music node.exe
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList @('server.mjs') -WorkingDirectory '%ROOT%\music-backend' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-music.log' -RedirectStandardError '%ROOT%\chalkle-music-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\music.pid' -Value $p.Id"
goto :eof
:music_sick
rem Alive but the health URL answered something else (500/503): the
rem process IS running. Restarting an alive-but-sick node every 20s was
rem the orphan machine (items 437/610). Log it, leave it alone.
echo [%date% %time%] music answered %mus% (not 200), leaving it alone >> "%LOG%"
goto :eof

rem ---- cloud backend on :3001 (node, needed for the Cloud Gaming tab) ----
:check_cloud
rem Any HTTP answer (even 400) means the Stratus backend is alive; 000 means
rem curl could not connect at all.
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:3001/cloud/v1/embed > "%TEMP%\ck-cld.txt" 2>nul
set /p cld=<"%TEMP%\ck-cld.txt"
if not "%cld%"=="000" if not "%cld%"=="" goto :eof
echo [%date% %time%] cloud backend down, cleaning stale then starting >> "%LOG%"
call :kill_stale cloud node.exe
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList @('api.js') -WorkingDirectory '%ROOT%\stratus-api' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-cloud.log' -RedirectStandardError '%ROOT%\chalkle-cloud-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\cloud.pid' -Value $p.Id"
goto :eof

rem ---- bitcord chat backend on :4123 (node; legacy embed + /bitcord proxy) ----
:check_bitcord
rem Any HTTP answer (even 401/404) means the chat backend is alive; 000 means
rem curl could not connect at all.
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 "http://127.0.0.1:4123/api/auth/me" > "%TEMP%\ck-bcd.txt" 2>nul
set /p bcd=<"%TEMP%\ck-bcd.txt"
if not "%bcd%"=="000" if not "%bcd%"=="" goto :eof
echo [%date% %time%] bitcord backend down, cleaning stale then starting >> "%LOG%"
call :kill_stale bitcord node.exe
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList @('server.cjs') -WorkingDirectory '%ROOT%\bitcord-backend' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-bitcord.log' -RedirectStandardError '%ROOT%\chalkle-bitcord-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\bitcord.pid' -Value $p.Id"
goto :eof

:check_esm
rem self-hosted esm.sh CDN on :80 (esm.lootline.xyz). Any HTTP answer
rem (even 404/500) means the process is alive; 000 means not listening.
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:80/ > "%TEMP%\ck-esm.txt" 2>nul
set /p esm=<"%TEMP%\ck-esm.txt"
if not "%esm%"=="000" if not "%esm%"=="" goto :eof
echo [%date% %time%] esm CDN down, cleaning stale then starting >> "%LOG%"
call :kill_stale esm esmd.exe
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath '%ROOT%\.freebuff\tools\esmd.exe' -ArgumentList @('""%ROOT%\.freebuff\tools\esm.sh\config.json""') -WorkingDirectory '%ROOT%\.freebuff\tools' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-esm.log' -RedirectStandardError '%ROOT%\chalkle-esm-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\esm.pid' -Value $p.Id"
goto :eof

rem ---- named tunnel for lootline.xyz ----
:check_tunnel
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 5 https://lootline.xyz/ > "%TEMP%\ck-tun.txt" 2>nul
set /p tun=<"%TEMP%\ck-tun.txt"
if "%tun%"=="200" goto :eof
rem tunnel is up but the site is unreachable - that is usually the local
rem origin, which :check_server restarts. Only bounce the tunnel itself when
rem the origin is fine, so we never kill a healthy cloudflared mid-connect.
"%CURL%" -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:4173/ > "%TEMP%\ck-srv.txt" 2>nul
set /p srv=<"%TEMP%\ck-srv.txt"
if not "%srv%"=="200" goto :eof
rem PID-file path first (see header): kill exactly our named tunnel so any
rem separately launched quick tunnel (temp link) survives the bounce. This
rem label chain replaces a parenthesized block on purpose: %TPID% would
rem expand before the set /p inside such a block.
if not exist "%PIDS%\tunnel.pid" goto tunnel_bounce_any
set /p TPID=<"%PIDS%\tunnel.pid" 2>nul
if not defined TPID goto tunnel_bounce_any
"%TL%" /FI "PID eq %TPID%" /FI "IMAGENAME eq cloudflared.exe" 2>nul | "%FNDF%" /I "cloudflared.exe" >nul
if errorlevel 1 goto tunnel_pid_stale
echo [%date% %time%] tunnel up but lootline.xyz unreachable (%tun%), restarting tunnel %TPID% >> "%LOG%"
"%TK%" /PID %TPID% /F >nul 2>&1
del "%PIDS%\tunnel.pid" >nul 2>&1
goto tunnel_bounce_wait
:tunnel_pid_stale
del "%PIDS%\tunnel.pid" >nul 2>&1
:tunnel_bounce_any
rem No usable PID file: fall back to the image-wide kill. This also ends a
rem separately launched quick tunnel, but a dead named tunnel outranks it.
"%TL%" /FI "IMAGENAME eq cloudflared.exe" 2>nul | "%FNDF%" /I "cloudflared.exe" >nul
if errorlevel 1 goto start_tunnel
echo [%date% %time%] tunnel up but lootline.xyz unreachable (%tun%), restarting tunnel >> "%LOG%"
"%TK%" /IM cloudflared.exe /F >nul 2>&1
:tunnel_bounce_wait
ping -n 3 127.0.0.1 >nul 2>&1
:start_tunnel
echo [%date% %time%] starting cloudflared named tunnel >> "%LOG%"
"%PS%" -NoProfile -Command "$p = Start-Process -FilePath '%CF%' -ArgumentList @('tunnel','run','%TUNNEL_ID%') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-named-tunnel.log' -RedirectStandardError '%ROOT%\chalkle-named-tunnel-err.log' -PassThru; Set-Content -LiteralPath '%PIDS%\tunnel.pid' -Value $p.Id"
goto :eof
