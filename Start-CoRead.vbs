' CoRead launcher - dev checkout (repository root)
'
' DOUBLE-CLICK THIS FILE to start CoRead. It is a .vbs and not a .bat on purpose:
' a .bat is run by cmd.exe, which is a console program, so double-clicking one
' always flashes a black window. WScript.exe -- the host for this file -- is a GUI
' program, so there is no console window at all and the tray can start fully
' hidden. (2026-10: the old 01-START-CoRead.bat was a one-line wrapper around
' this file and was removed; this is now the single entry point.)
'
' WHAT IT DOES: checks this really is the repo root and that node is available,
' starts installer\launcher\tray.ps1 hidden, then confirms it came up. Problems
' are reported with a message box -- there is no console to print to.
'
' DIFFERENCE FROM THE PACKAGE LAUNCHER: dev has no bundled node.exe and no
' internal\ folder -- agent\ and receiver\ sit directly next to this file, and
' node comes from PATH. The tray script detects that on its own; this launcher
' only warns early if node is missing (otherwise a hidden launch fails with
' nothing on screen at all).
'
' ARGUMENTS: none. Derived from this file's location:
'   here = <repo root>
'   tray = <repo root>\installer\launcher\tray.ps1
'
' ENCODING NOTE: ASCII-only on purpose -- Windows Script Host reads .vbs with the
' system ANSI codepage (GBK on Chinese Windows), so Chinese text here breaks
' string literals and the script fails to compile. Verified the hard way.
' The FILE NAME is ASCII for the same family of reasons: a Chinese name shows up
' as mojibake in any tool that reads the archive with the ANSI codepage.

Option Explicit

Dim fso, shell, here, tray, nodeOnPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
tray = fso.BuildPath(fso.BuildPath(fso.BuildPath(here, "installer"), "launcher"), "tray.ps1")

If Not fso.FileExists(tray) Then
  MsgBox "installer\launcher\tray.ps1 was not found:" & vbCrLf & tray & vbCrLf & vbCrLf & _
         "This launcher must run from the repository root.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

If Not fso.FolderExists(fso.BuildPath(here, "agent")) Then
  MsgBox "The agent\ folder was not found next to this file." & vbCrLf & vbCrLf & _
         "This launcher must run from the repository root." & vbCrLf & _
         "(For the packaged app, use the Start-CoRead.vbs inside the extracted " & _
         "zip's internal\ folder.)", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

nodeOnPath = False
On Error Resume Next
nodeOnPath = (shell.Run("cmd /c where node >nul 2>&1", 0, True) = 0)
On Error Goto 0
If Not nodeOnPath Then
  MsgBox "node was not found in PATH." & vbCrLf & vbCrLf & _
         "The dev checkout runs node from PATH (the packaged app ships its own" & vbCrLf & _
         "node.exe instead). Install Node 24+ and try again.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

' No -NodeExe: the tray detects the dev layout and takes node from PATH.
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
          tray & """ -AppDir """ & here & """", 0, False

WScript.Sleep 2500

Dim procs, found
found = False
On Error Resume Next
Set procs = GetObject("winmgmts:\\.\root\cimv2").ExecQuery( _
  "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='powershell.exe'")
On Error Goto 0
If IsObject(procs) Then
  Dim p
  For Each p In procs
    If Not IsNull(p.CommandLine) Then
      If InStr(p.CommandLine, "tray.ps1") > 0 Then found = True
    End If
  Next
End If

If Not found Then
  MsgBox "CoRead did not start." & vbCrLf & vbCrLf & _
         "Look at the log for the reason:" & vbCrLf & _
         fso.BuildPath(fso.BuildPath(here, "logs"), "tray.log") & vbCrLf & vbCrLf & _
         "Common cause: port 7239 is already taken by another CoRead copy." & vbCrLf & _
         "Quit that one from its tray icon, then try again.", _
         48, "CoRead - start failed"
  WScript.Quit 1
End If
