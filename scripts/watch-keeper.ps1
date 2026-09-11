# Chalkle keeper watchdog.
#
# The keeper (start-chalkle.bat) keeps the site, backends and the Cloudflare
# tunnel alive -- but if the keeper process itself dies mid-session, nothing
# brings it back until the next logon. This script closes that gap: run it from
# Task Scheduler every few minutes and it starts the keeper again if (and only
# if) no keeper loop is currently running.
#
# Idempotent: running it while a keeper is alive does nothing.

$ErrorActionPreference = 'SilentlyContinue'

$running = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*start-chalkle.bat*' }

if ($running) { exit 0 }

$vbs = Join-Path $PSScriptRoot 'start-keeper-hidden.vbs'
if (-not (Test-Path $vbs)) { exit 1 }

Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden
exit 0
