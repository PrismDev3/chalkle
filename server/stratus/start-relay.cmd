@echo off
rem Start the Stratus cloud-gaming relay on port 3001 (detached).
rem The site's server forwards /cloud/v1/* here, and this relay auto-creates
rem temp-mail raccoongame accounts per session (no manual API key needed).
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
start "chalkle-stratus" /min node api.js
timeout /t 3 >nul
netstat -ano | findstr ":3001" | findstr "LISTENING"