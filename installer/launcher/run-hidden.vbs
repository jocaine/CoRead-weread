' CoRead silent launcher
'
' What it does: starts the tray program with NO visible window.
' Why it is needed: running the .ps1 directly flashes a PowerShell console.
' WScript.Shell.Run takes a window-mode argument; passing 0 means
' "completely hidden and do not wait" -- the simplest reliable way on Windows,
' with no need to compile anything.
' This file is the whole reason users never see a black window.
'
' LAYOUT NOTE: this script lives in <package>\internal\, and the package root is
' its parent folder. The tray script sits next to this file; the program root
' (which holds data\ and the .bat entry points) is one level up. We pass the root
' as -AppDir so the tray finds data\ and the program files correctly.
'
' ENCODING NOTE: this file is deliberately ASCII-only.
' VBScript is read by Windows Script Host using the system ANSI codepage
' (GBK on Chinese Windows). UTF-8 Chinese text here breaks string literals and
' makes the script fail to compile with a syntax error. Verified the hard way.
' Chinese user-facing text lives in instructions-zh.txt instead.

Option Explicit

Dim fso, shell, here, root, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' here = <package>\internal   (this script's folder)
here = fso.GetParentFolderName(WScript.ScriptFullName)
' root = <package>            (one level up; holds data\ and the entry .bat files)
root = fso.GetParentFolderName(here)
ps1 = fso.BuildPath(here, "tray.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "tray.ps1 was not found:" & vbCrLf & ps1 & vbCrLf & vbCrLf & _
         "The package looks incomplete. Please extract the whole zip again.", 16, "CoRead - cannot start"
  WScript.Quit 1
End If

' -ExecutionPolicy Bypass: do not depend on the machine's execution policy
'                          (a fresh Windows install has it set to Restricted)
' -WindowStyle Hidden    : second line of defence, in case a window is created
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -AppDir """ & root & """"

' 0 = hidden window, do not wait (the tray must keep running, so we cannot wait)
shell.Run cmd, 0, False
