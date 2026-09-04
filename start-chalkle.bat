@echo off
setlocal EnableExtensions
title Chalkle keeper
cd /d "%~dp0"

rem =====================================================================
rem  Chalkle keeper: keeps the local site + Cloudflare tunnels alive.
rem  Run once at logon (or from Task Scheduler). Restarts anything that
rem  dies, so lootline.xyz stays up as long as this PC is on.
rem =====================================================================

set "PY=C:\Python314\python.exe"
if not exist "%PY%" set "PY=python"
set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=cloudflared"
set "TUNNEL_ID=4b871657-7390-4c4a-b6b1-a51f9710a2de"
set "LOG=%~dp0keeper.log"

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
start "Chalkle server" /MIN "%PY%" "%~dp0serve-chalk.py"
goto :eof

rem ---- music backend on :3004 (node, needed for the Music tab) ----
:check_music
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:3004/health > "%TEMP%\ck-mus.txt" 2>nul
set /p mus=<"%TEMP%\ck-mus.txt"
if "%mus%"=="200" goto :eof
if not "%mus%"=="200" (
  echo [%date% %time%] music backend down, starting >> "%LOG%"
  cd /d "%~dp0music-backend"
  start "Chalkle music" /MIN node server.mjs
  cd /d "%~dp0"
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
start "Chalkle tunnel" /MIN "%CF%" tunnel run %TUNNEL_ID%
timeout /t 4 /nobreak >nul 2>&1
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if errorlevel 1 powershell -NoProfile -Command "Start-Process -FilePath '%CF%' -ArgumentList @('tunnel','run','%TUNNEL_ID%') -WindowStyle Minimized"
goto :eof