@echo off
cd /d "%~dp0"

:: Kill leftovers from previous runs
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7239.*LISTENING"') do taskkill /PID %%a /F >nul 2>&1
powershell -c "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

:: Start receiver in background (hidden)
start "CoRead Receiver" /MIN cmd /c "cd /d %~dp0 && node receiver\index.js"
echo Receiver started...

:: Run agent in this window (blocks here)
echo Starting agent... (type /exit to quit)
cd /d "%~dp0agent"
node --env-file-if-exists=.env index.js

:: Agent exited -- clean up receiver
echo Cleaning up...
taskkill /FI "WINDOWTITLE eq CoRead Receiver" /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7239.*LISTENING"') do taskkill /PID %%a /F >nul 2>&1
echo Bye.
