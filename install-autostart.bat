@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem =====================================================================
rem  Registers the Chalkle keeper so the site comes back up at every logon.
rem  Two layers (both harmless together):
rem    1. Startup folder shortcut (current user, no admin needed)
rem    2. Task Scheduler ONLOGON task (more reliable, may ask for admin)
rem =====================================================================

set "BAT=%~dp0start-chalkle.bat"
set "VBS=%TEMP%\chalkle-keeper.vbs"

if not exist "%BAT%" (
  echo start-chalkle.bat not found next to this script.
  pause
  exit /b 1
)

rem ---- 1. Startup folder: a VBS that launches the bat hidden ----
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%" (
  (
    echo Set sh = CreateObject("WScript.Shell"^)
    echo sh.Run ""%BAT%"", 0, False
  ) > "%VBS%"
  copy /Y "%VBS%" "%STARTUP%\ChalkleKeeper.vbs" >nul 2>&1
  del "%VBS%" >nul 2>&1
  echo [1/2] Startup folder entry installed.
) else (
  echo [1/2] Startup folder not found, skipping.
)

rem ---- 2. Task Scheduler ONLOGON ----
schtasks /Create /F /TN "ChalkleKeeper" /TR "\"%BAT%\"" /SC ONLOGON /RL LIMITED >nul 2>&1
if %errorlevel%==0 (
  echo [2/2] Task Scheduler entry installed ^(runs at every logon^).
) else (
  echo [2/2] Task Scheduler needs admin for some setups. Try running this as
  echo      Administrator, or just rely on the Startup folder entry.
)

echo.
echo Done. Chalkle will start itself at every logon from now on.
echo Test now? Run:  start-chalkle.bat
pause