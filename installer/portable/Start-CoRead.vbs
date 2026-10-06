' CoRead launcher - portable package
'
' DOUBLE-CLICK THIS FILE to start CoRead. It is a .vbs and not a .bat on purpose:
' a .bat is run by cmd.exe, which is a console program, so double-clicking one
' always flashes a black window (the old one kept it on screen for ~8 seconds
' because of its "timeout" waits). WScript.exe -- the host for this file -- is a
' GUI program, so nothing flashes and the tray starts fully hidden.
' (2026-10: 01-START-CoRead.bat was a one-line wrapper around this file and was
' removed; this is now the single entry point.)
'
' WHAT IT DOES: checks the package is complete, starts internal\tray.ps1 hidden,
' then confirms it came up. Problems are reported with a message box -- there is
' no console to print to.
'
' ARGUMENTS: none. Everything is derived from this file's location:
'   here = <package root>\internal (this file ships there, next to tray.ps1)
'   data\ and logs\ live one level up, at the package root (-AppDir)
'
' ENCODING NOTE: ASCII-only on purpose -- Windows Script Host reads .vbs with the
' system ANSI codepage (GBK on Chinese Windows), so Chinese text here breaks
' string literals and the script fails to compile. Verified the hard way.
' The FILE NAME is ASCII for the same family of reasons: a Chinese name shows up
' as mojibake in any tool that reads the archive with the ANSI codepage.

Option Explicit

Dim fso, shell, here, progDir, appRoot, tray, node
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
' TWO different folders, do not mix them up (mixing them up is exactly the bug this
' file shipped with once):
'   progDir = where tray.ps1 and node.exe live. In the SHIPPED package that is
'             <root>\internal (this file sits there too); the internal\ fallback
'             covers the unpacked source layout where this file is at the root.
'   appRoot = the PACKAGE ROOT, the folder holding data\, logs\, extension\.
'             The tray needs this one for -AppDir: it resolves data\ and logs\
'             from it. Passing progDir instead makes the tray write its logs into
'             <root>\internal\logs (which does not exist) and fail silently.
If fso.FileExists(fso.BuildPath(here, "tray.ps1")) Then
  progDir = here
  appRoot = here                       ' running from the root (source layout)
  If LCase(fso.GetFileName(here)) = "internal" Then appRoot = fso.GetParentFolderName(here)
Else
  progDir = fso.BuildPath(here, "internal")
  appRoot = here
End If
tray = fso.BuildPath(progDir, "tray.ps1")
node = fso.BuildPath(progDir, "node.exe")

If Not fso.FileExists(tray) Then
  MsgBox "internal\tray.ps1 was not found:" & vbCrLf & tray & vbCrLf & vbCrLf & _
         "The folder looks incomplete, or this file was moved out of it." & vbCrLf & _
         "Please extract the WHOLE zip into one folder and run it from there.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

If Not fso.FileExists(node) Then
  MsgBox "internal\node.exe was not found:" & vbCrLf & node & vbCrLf & vbCrLf & _
         "The folder looks incomplete. Please extract the whole zip again.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

' 0 = hidden window, False = do not wait. The tray keeps running in the
' background and is the only thing the user should ever see (its tray icon).
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
          tray & """ -AppDir """ & appRoot & """ -NodeExe """ & node & """", 0, False

' Give the tray a moment, then confirm. Doing it here (instead of in the .bat)
' keeps the console window out of the picture entirely: the .bat hands off and
' exits immediately.
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
