# Chalkle keeper single-instance check.
#
# Called by start-chalkle.bat at startup. Exit code 1 means another keeper
# cmd is already running and the caller must exit; exit 0 means the caller
# is the only one.
#
# The caller's own cmd is excluded by parent PID: the keeper runs powershell
# synchronously, so this process's parent IS the calling keeper cmd. Matching
# by command line alone would always count the caller itself (its command
# line contains start-chalkle.bat).
$ErrorActionPreference = 'SilentlyContinue'

$parent = (Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID)).ParentProcessId

$others = @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
    Where-Object {
        $_.ProcessId -ne $parent -and
        $_.CommandLine -like '*start-chalkle.bat*'
    })

if ($others.Count -gt 0) { exit 1 }
exit 0
