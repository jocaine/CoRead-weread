@echo off
rem ============================================================================
rem  CoRead stop script
rem  ASCII-only on purpose (see the note in start-portable.bat).
rem
rem  Normally you should quit via the tray icon instead. This file is the
rem  fallback for when the tray is gone but the background processes remain.
rem
rem  It first drops a stop-request sentinel so the agent can save its memory
rem  and exit gracefully, then kills whatever is left.
rem
rem  NOTE (2026-10): the sentinel path must match STOP_FILE in agent/lib/paths.js,
rem  which is  <package root>\data\sessions\stop-request .
rem  This script lives in <package root>\internal, hence the leading "..".
rem  If you change the path, change it in agent/lib/paths.js AND installer\launcher\tray.ps1 too.
rem ============================================================================
setlocal
cd /d "%~dp0"

echo Stopping CoRead...

set "SENTINEL=..\data\sessions\stop-request"

echo   Step 1/2: asking the agent to save memory (up to 90s)...
if not exist "..\data\sessions" mkdir "..\data\sessions" 2>nul
type nul > "%SENTINEL%" 2>nul

set /a waited=0
:waitloop
if not exist "%SENTINEL%" goto saved
if %waited% geq 90 goto force
timeout /t 3 /nobreak >nul
set /a waited+=3
goto waitloop

:saved
echo   Agent saved and exited.
goto killrest

:force
del "%SENTINEL%" 2>nul
echo   Agent did not exit in 90s, forcing.
echo   (Work in progress stays in the topic stack; it is saved as you go.)

:killrest
echo   Step 2/2: stopping receiver and tray...

rem Kill whatever holds port 7239
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7239.*LISTENING"') do taskkill /PID %%a /F >nul 2>&1

rem Kill the tray script only, never other PowerShell windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }" >nul 2>&1

if exist "logs" echo   Done. Logs are in the logs folder.

echo Done.
timeout /t 3 /nobreak >nul
endlocal
