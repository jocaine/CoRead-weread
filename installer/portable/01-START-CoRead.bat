@echo off
rem ============================================================================
rem  CoRead portable launcher
rem
rem  Read this first:
rem    - What you actually touch:  01-START-CoRead.bat  (this file), data\
rem    - Everything else lives in: internal\  (program files; safe to ignore)
rem    - Your reading records / chat history are in: data\
rem
rem  IMPORTANT: this file is deliberately ASCII-only.
rem  cmd.exe reads .bat files using the system ANSI codepage (GBK on Chinese
rem  Windows), so UTF-8 Chinese text here becomes mojibake, and a mid-file
rem  "chcp 65001" desyncs cmd's byte-by-byte parser (it re-reads the file while
rem  executing) which makes it try to run the mojibake as commands.
rem  Chinese instructions live in: internal\instructions-zh.txt
rem ============================================================================
setlocal
cd /d "%~dp0"

if not exist "internal\node.exe" (
  echo.
  echo  [ERROR] internal\node.exe not found.
  echo.
  echo  The package looks incomplete, or this file was moved out of its folder.
  echo  Please extract the WHOLE zip into one folder and run it from there.
  echo.
  pause
  exit /b 1
)

if not exist "internal\tray.ps1" (
  echo.
  echo  [ERROR] internal\tray.ps1 not found. The package is incomplete.
  echo  Please extract the whole zip again.
  echo.
  pause
  exit /b 1
)

echo Starting CoRead...
echo.
echo   It runs in the background. A tray icon will appear near the clock.
echo   Right-click that icon to open WeRead, open your data folder, or quit.
echo.
echo   Your data lives in:  %~dp0data
echo.

rem Launch hidden via VBS so the user never sees a console window.
cscript //nologo "%~dp0internal\run-hidden.vbs"

rem Give the tray a moment, then verify it actually started.
timeout /t 3 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*tray.ps1*' }; if ($p) { Write-Host '  [OK] CoRead is running. Look for the tray icon near the clock.'; exit 0 } else { Write-Host '  [WARN] Tray did not start. See internal\instructions-zh.txt'; exit 1 }"

echo.
timeout /t 5 /nobreak >nul
endlocal
