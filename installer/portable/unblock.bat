@echo off
rem ============================================================================
rem  Unblock CoRead (removes the "Mark of the Web")
rem
rem  Why you may need this:
rem    Windows tags files that came from the internet / a network drive / a USB
rem    stick / a cloud-sync folder with a hidden flag (the "Mark of the Web",
rem    stored as an NTFS alternate data stream named Zone.Identifier).
rem    The first time you run such a file, Windows shows:
rem        "Open File - Security Warning ... Publisher: Unknown Publisher"
rem    Unblocking the files removes that prompt. No code signing needed.
rem
rem  Run this if you see that warning. Then start CoRead normally.
rem
rem  ASCII-only on purpose (see the note in start-portable.bat).
rem ============================================================================
setlocal
cd /d "%~dp0"

echo Removing the "downloaded from the internet" mark from all files here...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$n = 0;" ^
  "Get-ChildItem -LiteralPath $PWD -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {" ^
  "  $s = Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue;" ^
  "  if ($s) { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue; $n++ }" ^
  "};" ^
  "Write-Host ('  Unblocked ' + $n + ' file(s).')"

echo.
echo Done. Now double-click start-portable.bat
echo.
pause
endlocal
