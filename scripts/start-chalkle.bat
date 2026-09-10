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

rem ---- cloud backend on :3001 (node, needed for the Cloud Gaming tab) ----
:check_cloud
rem Any HTTP answer (even 400) means the Stratus backend is alive; 000 means
rem curl could not connect at all.
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:3001/cloud/v1/embed > "%TEMP%\ck-cld.txt" 2>nul
set /p cld=<"%TEMP%\ck-cld.txt"
if not "%cld%"=="000" if not "%cld%"=="" goto :eof
echo [%date% %time%] cloud backend down, starting >> "%LOG%"
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList @('api.js') -WorkingDirectory '%ROOT%\stratus-api' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-cloud.log' -RedirectStandardError '%ROOT%\chalkle-cloud-err.log'"
goto :eof

rem ---- bitcord chat backend on :4123 (node; legacy embed + /bitcord proxy) ----
:check_bitcord
rem Any HTTP answer (even 401/404) means the chat backend is alive; 000 means
rem curl could not connect at all.
curl -s -o nul -w "%%{http_code}" --max-time 3 "http://127.0.0.1:4123/api/auth/me" > "%TEMP%\ck-bcd.txt" 2>nul
set /p bcd=<"%TEMP%\ck-bcd.txt"
if not "%bcd%"=="000" if not "%bcd%"=="" goto :eof
echo [%date% %time%] bitcord backend down, starting >> "%LOG%"
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList @('server.cjs') -WorkingDirectory '%ROOT%\bitcord-backend' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-bitcord.log' -RedirectStandardError '%ROOT%\chalkle-bitcord-err.log'"
goto :eof

:check_esm
rem self-hosted esm.sh CDN on :80 (esm.lootline.xyz). Any HTTP answer
rem (even 404/500) means the process is alive; 000 means not listening.
curl -s -o nul -w "%%{http_code}" --max-time 3 http://127.0.0.1:80/ > "%TEMP%\ck-esm.txt" 2>nul
set /p esm=<"%TEMP%\ck-esm.txt"
if not "%esm%"=="000" if not "%esm%"=="" goto :eof
echo [%date% %time%] esm CDN down, starting >> "%LOG%"
powershell -NoProfile -Command "Start-Process -FilePath '%ROOT%\.freebuff\tools\esmd.exe' -ArgumentList @('""%ROOT%\.freebuff\tools\esm.sh\config.json""') -WorkingDirectory '%ROOT%\.freebuff\tools' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%\chalkle-esm.log' -RedirectStandardError '%ROOT%\chalkle-esm-err.log'"
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