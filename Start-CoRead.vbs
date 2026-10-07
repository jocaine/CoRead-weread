' CoRead launcher - the ONE entry point (repo root AND package root)
'
' The same file is used by the dev checkout and the shipped package, on purpose:
' development then runs the exact start/stop path users run (write stop sentinel
' -> wait for the agent to exit -> close the databases), which is how those paths
' get tested at all. It ships to the PACKAGE ROOT -- the one thing a user has to
' double-click should not live in a folder the instructions call "do not touch".
' The only difference between the two layouts is node.exe: a package ships one
' inside internal\, a dev checkout takes node from PATH. This file passes
' -NodeExe only when node.exe really sits next to tray.ps1.
'
' DOUBLE-CLICK THIS FILE to start CoRead. It is a .vbs and not a .bat on purpose:
' a .bat is run by cmd.exe, which is a console program, so double-clicking one
' always flashes a black window (the old one kept it on screen for ~8 seconds
' because of its "timeout" waits). WScript.exe -- the host for this file -- is a
' GUI program, so nothing flashes and the tray starts fully hidden.
' (2026-10: 01-START-CoRead.bat was a one-line wrapper around this file and was
' removed; this is now the single entry point.)
'
' WHAT IT DOES: locates tray.ps1, starts it hidden, then confirms it
' came up. Problems are reported with a message box -- there is no console.
'
' ARGUMENTS: none. Everything is derived from this file's location.
'
' WHERE THIS FILE LIVES (2026-10-07: moved from internal\ to the package root):
'   here = <package root>   -- the folder holding data\, logs\, extension\
'   tray = <package root>\internal\tray.ps1
' Why the root: this is the ONE thing the user has to double-click. Putting it
' inside internal\ -- which the instructions describe as "program files, do not
' touch" -- was self-contradictory. The package root now reads: read me first,
' then double-click me.
'
' WHY IT SEARCHES INSTEAD OF USING A FIXED PATH: "unzip the new version over the
' old folder" is the supported upgrade path, so old and new layouts coexist on
' disk. The search accepts both, which means an upgraded package starts working
' immediately -- no need to delete anything first.
'   tray.ps1  is looked for in:  here\, here\internal\, here\installer\launcher\
'   node.exe  is looked for in:  the folder tray.ps1 was found in
' Give -NodeExe only when node.exe sits in the SAME folder as tray.ps1; that is
' how the tray tells a packaged copy from a source checkout.
'
' ENCODING NOTE: ASCII-only on purpose -- Windows Script Host reads .vbs with the
' system ANSI codepage (GBK on Chinese Windows), so Chinese text here breaks
' string literals and the script fails to compile. Verified the hard way.
' NO UTF-8 BOM either: the packer rejects any .bat/.vbs carrying non-ASCII bytes,
' and a BOM is three of them. Plain ASCII, no BOM, always.
' The FILE NAME is ASCII for the same family of reasons: a Chinese name shows up
' as mojibake in any tool that reads the archive with the ANSI codepage.

Option Explicit

Dim fso, shell
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Helpers. VBScript has no built-in file search and no short-circuit evaluation,
' hence the If nesting / explicit exits.
Function FindFile(baseDir, relPath)
  FindFile = ""
  If fso.FileExists(fso.BuildPath(baseDir, relPath)) Then
    FindFile = fso.BuildPath(baseDir, relPath)
  End If
End Function

Function FindFolder(baseDir, relPath)
  FindFolder = ""
  If fso.FolderExists(fso.BuildPath(baseDir, relPath)) Then
    FindFolder = fso.BuildPath(baseDir, relPath)
  End If
End Function

Dim here, progDir, appRoot, tray, node, pkgName

here = fso.GetParentFolderName(WScript.ScriptFullName)

' -- Which folder holds tray.ps1 (and, in a package, node.exe)? ----------------
progDir = FindFolder(here, "internal")
If progDir = "" Then progDir = FindFolder(here, "installer\launcher")
If progDir = "" Then
  If fso.FileExists(fso.BuildPath(here, "tray.ps1")) Then progDir = here
End If
If progDir = "" Then
  MsgBox "tray.ps1 was not found." & vbCrLf & vbCrLf & _
         "Looked in:" & vbCrLf & _
         "  " & fso.BuildPath(here, "internal") & vbCrLf & _
         "  " & fso.BuildPath(here, "installer\launcher") & vbCrLf & vbCrLf & _
         "The folder looks incomplete. Please extract the WHOLE zip into one" & vbCrLf & _
         "folder and run this file from there.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

' -- appRoot = the PACKAGE ROOT, the folder holding data\, logs\, extension\ ---
' The tray needs this one for -AppDir: it resolves data\ and logs\ from it.
' Passing progDir instead makes the tray write its logs into <root>\internal\logs
' (which does not exist) and fail silently.
'
' Two shapes to cover: this file at the package root (progDir = here\internal),
' and a new zip unzipped straight over an old one, where a STALE copy of this
' file still sits in internal\ (progDir = here, appRoot = the parent).
appRoot = here
If LCase(fso.GetFileName(here)) = "internal" Then
  appRoot = fso.GetParentFolderName(here)
  pkgName = fso.GetFileName(appRoot)
Else
  pkgName = fso.GetFileName(here)
End If

tray = fso.BuildPath(progDir, "tray.ps1")
node = fso.BuildPath(progDir, "node.exe")

' -- Give the tray a node only when this really is a packaged copy ------------
' The tray decides "packaged vs source checkout" by asking whether node.exe sits
' next to tray.ps1. So node.exe must be validated HERE and passed explicitly:
' hand it a missing node.exe and the tray takes the packaged branch and dies
' without saying anything. Passing nothing keeps the tray on PATH, which is
' exactly right for a source checkout.
Dim nodeArg
nodeArg = ""
If fso.FileExists(node) Then nodeArg = " -NodeExe """ & node & """"

' Sanity check before launching: a package root holds data\, internal\ and (in
' an upgrade over an old version) extension\. If none of them is there, the user
' is probably running this file from somewhere it was never meant to live --
' often "it got copied out of the zip on its own", which used to fail with a
' totally silent no-op.
Dim hasData, hasInternal, hasExtension
hasData = fso.FolderExists(fso.BuildPath(appRoot, "data"))
hasInternal = fso.FolderExists(fso.BuildPath(appRoot, "internal"))
hasExtension = fso.FolderExists(fso.BuildPath(appRoot, "extension"))
If (Not hasData) And (Not hasInternal) And (Not hasExtension) Then
  MsgBox "This file does not look like it is inside a CoRead folder." & vbCrLf & vbCrLf & _
         "It was found at:" & vbCrLf & _
         "  " & appRoot & vbCrLf & vbCrLf & _
         "A CoRead folder contains data\, internal\ and extension\ next to this" & vbCrLf & _
         "file. If you copied this file out of the zip by itself, put it back:" & vbCrLf & _
         "please extract the WHOLE zip into one folder and run it from there.", _
         16, "CoRead - cannot start"
  WScript.Quit 1
End If

' 0 = hidden window, False = do not wait. The tray keeps running in the
' background and is the only thing the user should ever see (its tray icon).
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
          tray & """ -AppDir """ & appRoot & """" & nodeArg, 0, False

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
         "  " & fso.BuildPath(appRoot, "logs\tray.log") & vbCrLf & vbCrLf & _
         "Common cause: port 7239 is already taken by another CoRead copy." & vbCrLf & _
         "Quit that one from its tray icon, then try again.", _
         48, "CoRead - start failed"
  WScript.Quit 1
End If
