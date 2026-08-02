@echo off
echo Stopping CoRead...

:: Kill receiver on port 7239
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7239.*LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
    echo Receiver (PID %%a) stopped
)

:: Kill agent processes
powershell -c "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agent*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('Agent (PID '+$_.ProcessId+') stopped') }"

echo Done!
