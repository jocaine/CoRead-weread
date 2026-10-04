@echo off
rem ============================================================================
rem  CoRead installer build script
rem
rem  Usage: double-click this file, or run it from a terminal:
rem      installer\build-installer.bat
rem
rem  ASCII-only on purpose. cmd.exe reads .bat files with the system ANSI
rem  codepage (GBK on Chinese Windows), so UTF-8 Chinese text here turns into
rem  mojibake and cmd then tries to execute that mojibake as commands.
rem  Chinese docs live in: ../distribution-design.md and ./README-zh.md
rem
rem  What it does:
rem    1. build a clean staging dir      (pack-portable.ps1)
rem    2. read the version from          extension\manifest.json
rem    3. compile the installer          (Inno Setup)
rem ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo.
echo === CoRead installer build ===
echo Repo root: %CD%
echo.

rem --- 1. version from the extension manifest (single source of truth) ------
set "MANIFEST=extension\manifest.json"
if not exist "%MANIFEST%" (
  echo [ERROR] %MANIFEST% not found
  pause
  exit /b 1
)
set "APPVER="
for /f "usebackq tokens=2 delims=:" %%v in (`findstr /r /c:"\"version\"" "%MANIFEST%"`) do (
  if not defined APPVER (
    set "RAW=%%v"
    set "RAW=!RAW: =!"
    set "RAW=!RAW:,=!"
    set "RAW=!RAW:\"=!"
    set "APPVER=!RAW!"
  )
)
if not defined APPVER (
  echo [ERROR] could not read version from manifest.json
  pause
  exit /b 1
)
echo   Extension version: %APPVER%
echo.

rem --- 2. staging dir --------------------------------------------------------
echo --- Building staging dir ---
powershell -NoProfile -ExecutionPolicy Bypass -File "installer\pack-portable.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] staging failed, aborting (no installer produced).
  pause
  exit /b 1
)

rem --- 3. find Inno Setup (6 or 7) ------------------------------------------
set "ISCC="
for %%p in (
  "%ProgramFiles%\Inno Setup 7\ISCC.exe"
  "%ProgramFiles(x86)%\Inno Setup 7\ISCC.exe"
  "%LOCALAPPDATA%\Programs\Inno Setup 7\ISCC.exe"
  "%ProgramFiles%\Inno Setup 6\ISCC.exe"
  "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
  "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
) do (
  if not defined ISCC if exist %%p set "ISCC=%%~p"
)
if not defined ISCC (
  where ISCC.exe >nul 2>&1 && set "ISCC=ISCC.exe"
)

if not defined ISCC (
  echo.
  echo ============================================================
  echo  Inno Setup not found (6 or 7 both fine). Cannot compile.
  echo.
  echo  Download: https://jrsoftware.org/isdl.php
  echo  Default install options are fine; no admin rights needed.
  echo.
  echo  NOTE: that download page is hosted on GitHub and may be
  echo  unreachable from mainland China. A mirror that works is to
  echo  prefix the file URL with:  https://gh-proxy.com/
  echo.
  echo  Without Inno Setup you can still ship the portable build:
  echo    installer\build\app   (staging dir, already generated)
  echo  or build the portable zip:
  echo    powershell -ExecutionPolicy Bypass -File installer\pack-portable-zip.ps1
  echo ============================================================
  echo.
  pause
  exit /b 2
)

echo.
echo --- Compiling installer ---
echo   ISCC: %ISCC%
"%ISCC%" /DAppVersion=%APPVER% "installer\co-read.iss"
if errorlevel 1 (
  echo.
  echo [ERROR] compile failed, see the Inno Setup output above.
  pause
  exit /b 1
)

echo.
echo === Done ===
if exist "installer\build\out\CoRead-Setup-%APPVER%.exe" (
  echo   Installer: %CD%\installer\build\out\CoRead-Setup-%APPVER%.exe
)
echo.
echo   Next: build the portable zip too? Run
echo     powershell -ExecutionPolicy Bypass -File installer\pack-portable-zip.ps1
echo.
pause
endlocal
