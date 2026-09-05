' Launches start-chalkle.bat with no visible window (taskbar stays clean).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("Wscript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & base & "\start-chalkle.bat""", 0, False