@echo off
rem ============================================================================
rem  CoRead updater - entry point
rem
rem  HOW TO USE
rem    - Drag a new CoRead-<version>-portable.zip onto this file, or
rem    - double-click it and pick the zip in the dialog.
rem
rem  WHY THIS IS A .cmd (and not a .vbs like Start-CoRead.vbs)
rem    Start-CoRead.vbs is a .vbs so that nothing flashes: the app must start
rem    silently. Updating is the opposite - the user needs a window that shows
rem    progress and errors, so a console program (cmd) is the right tool here.
rem    Do not "fix" this into a .vbs.
rem
rem  WHY IT COPIES ITSELF TO %TEMP% FIRST
rem    The update deletes and re-creates the folder this script lives in. cmd.exe
rem    re-reads a .cmd file from disk while it runs, so replacing it mid-run can
rem    make cmd execute garbage. So: copy self + the real script to %TEMP%, start
rem    the copy in a new window, and exit immediately. Everything after that runs
rem    from %TEMP%, where nothing touches it.
rem
rem  ASCII-ONLY ON PURPOSE: cmd.exe reads .bat/.cmd using the system ANSI codepage
rem    (GBK on Chinese Windows). UTF-8 Chinese here becomes mojibake and cmd tries
rem    to run it as commands. All Chinese text lives in internal\update.ps1.
rem ============================================================================
setlocal

if /i "%~1"=="--work" goto :work

rem ---- original copy: hand off to a temp copy, then get out of the way --------
set "WORKDIR=%TEMP%\coread-update"
if exist "%WORKDIR%" rmdir /s /q "%WORKDIR%" 2>nul
mkdir "%WORKDIR%" 2>nul

copy /y "%~f0" "%WORKDIR%\Update-CoRead.cmd" >nul 2>&1
if errorlevel 1 goto :copyfail
copy /y "%~dp0internal\update.ps1" "%WORKDIR%\update.ps1" >nul 2>&1
if errorlevel 1 goto :copyfail

rem %~1 = the zip the user dropped on us (may be empty)
start "CoRead update" cmd /c ""%WORKDIR%\Update-CoRead.cmd" --work "%~dp0." "%~1""
exit /b 0

:copyfail
echo.
echo  [ERROR] Could not copy the updater to %WORKDIR%.
echo  Check that your TEMP folder is writable, then try again.
echo.
pause
exit /b 1

rem ---- temp copy: do the real work ------------------------------------------
:work
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -Root "%~2" -Zip "%~3"
if errorlevel 1 (
  echo.
  echo  Update failed. Read the message above.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
