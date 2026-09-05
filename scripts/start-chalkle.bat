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
rem =====================================================================

set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"
set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=cloudflared"
set "TUNNEL_ID=4b871657-7390-4c4a-b6b1-a51f9710a2de"
set "LOG=%ROOT%\keeper.log"

echo [%date% %time%] Chalkle keeper starting >> "%LOG%"

:LOOP
call :check_server
call :check_music
call :check_tunnel
timeout /t 20 /nobreak >nul 2>&1
goto LOOP

rem ---- server on :4173 ----
:check_server
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:4173/ > "%TEMP%\ck-srv.txt" 2>nul
set /p srv=<"%TEMP%\ck-srv.txt"
if "%srv%"=="200" goto :eof
echo [%date% %time%] server down (was %%srv%%), starting >> "%LOG%"
rem Double-quoted argument: Start-Process does not quote array items that
rem contain spaces on its own, and %~dp0 has spaces, so embed the quotes.
powershell -NoProfile -Command "Start-Process -FilePath '%PY%' -ArgumentList @('""%ROOT%\server\serve-chalk.py""') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-server.log' -RedirectStandardError '%ROOT%\chalkle-server-err.log'"
goto :eof

rem ---- music backend on :3004 (node, needed for the Music tab) ----
:check_music
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:3004/health > "%TEMP%\ck-mus.txt" 2>nul
set /p mus=<"%TEMP%\ck-mus.txt"
if "%mus%"=="200" goto :eof
if not "%mus%"=="200" (
  echo [%date% %time%] music backend down, starting >> "%LOG%"
  powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList @('server.mjs') -WorkingDirectory '%ROOT%\music-backend' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-music.log' -RedirectStandardError '%ROOT%\chalkle-music-err.log'"
)
goto :eof

rem ---- named tunnel for lootline.xyz ----
:check_tunnel
curl -s -o nul -w "%%{http_code}" --max-time 5 https://lootline.xyz/ > "%TEMP%\ck-tun.txt" 2>nul
set /p tun=<"%TEMP%\ck-tun.txt"
if "%tun%"=="200" goto :eof
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if errorlevel 1 goto :start_tunnel
rem tunnel is up but the site is unreachable - that is usually the local
rem origin, which :check_server restarts. Only bounce the tunnel itself when
rem the origin is fine, so we never kill a healthy cloudflared mid-connect.
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:4173/ > "%TEMP%\ck-srv.txt" 2>nul
set /p srv=<"%TEMP%\ck-srv.txt"
if not "%srv%"=="200" goto :eof
echo [%date% %time%] tunnel up but lootline.xyz unreachable (%%tun%%), restarting tunnel >> "%LOG%"
taskkill /IM cloudflared.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1
:start_tunnel
echo [%date% %time%] starting cloudflared named tunnel >> "%LOG%"
powershell -NoProfile -Command "Start-Process -FilePath '%CF%' -ArgumentList @('tunnel','run','%TUNNEL_ID%') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-named-tunnel.log' -RedirectStandardError '%ROOT%\chalkle-named-tunnel-err.log'"
goto :eof