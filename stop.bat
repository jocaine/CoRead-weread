@echo off
setlocal
echo Stopping CoRead...

:: 1) Ask agent to save memory and exit gracefully.
::    Write sentinel file agent\.stop; the agent poller detects it,
::    merges profile/soul from the session journal, then exits by itself.
if not exist "%~dp0agent\.stop" type nul > "%~dp0agent\.stop"

:: 2) Quick path (5s): an idle agent notices the sentinel within ~0.3s,
::    deletes it (fs.unlinkSync) and exits. If the sentinel disappears by
::    itself, the agent already saved and exited - skip the slow path.
powershell -NoProfile -Command "$i = 0; while ($i -lt 10 -and (Test-Path '%~dp0agent\.stop')) { Start-Sleep -Milliseconds 500; $i++ }; if (-not (Test-Path '%~dp0agent\.stop')) { Write-Host 'Agent saved memory and exited.'; exit 0 } else { exit 1 }"
if %ERRORLEVEL% EQU 0 goto :after_agent

:: 3) Sentinel still there: the agent is busy saving (merge can take ~30-60s)
::    or not responding. Wait up to 90s for it to exit; force-kill on timeout.
::    All logic lives inside PowerShell to avoid batch quoting hell.
::    The agent is launched by start.bat as "node ... index.js" (no receiver/playwright in cmdline).
powershell -NoProfile -Command "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*index.js*' -and $_.CommandLine -notlike '*receiver*' -and $_.CommandLine -notlike '*playwright*' }); if ($procs.Count -eq 0) { Write-Host 'No running agent found.' } else { foreach ($p in $procs) { Write-Host ('Waiting for agent (PID ' + $p.ProcessId + ') to save memory and exit...'); $dl = (Get-Date).AddSeconds(90); while ((Get-Date) -lt $dl) { if (-not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) { Write-Host 'Agent exited cleanly.'; break }; Start-Sleep -Seconds 1 }; if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) { Write-Host 'Agent did not exit in time, forcing kill...'; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } } }"

:after_agent
:: 4) Clear the sentinel (agent deletes it on clean exit; delete here as fallback so a
::    stale .stop never auto-triggers shutdown on next startup)
del "%~dp0agent\.stop" 2>nul

:: 5) Stop the receiver (no long-term memory, force is fine).
::    NOTE: no parentheses inside this do-block - cmd breaks block parsing on them.
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7239.*LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
    echo Receiver PID %%a stopped
)

echo Done!
endlocal
