# CoRead 托盘程序
#
# 为什么用 PowerShell 而不是编译一个 exe：
#   Windows 自带 PowerShell 和 WinForms，能直接做托盘图标 + 右键菜单，
#   不需要额外运行时、不需要编译、不需要签名。体积为零。
# 这个文件是"临时托盘"，接口刻意留成可替换的：
#   将来换成正式的托盘 exe，只要保证同样的行为（拉起两个进程、能停、能看日志）即可。

param(
  [string]$AppDir = (Split-Path -Parent $PSCommandPath),
  [switch]$AutoStart
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 目录约定（两层结构）─────────────────────────────────────────────
#   <包根>\              ← 用户看到的：data\（数据）、logs\、几个 .bat 入口
#   <包根>\internal\     ← 程序自己用的：node.exe、tray.ps1、agent\、receiver\、extension\
#
# -AppDir 由 run-hidden.vbs 传入，指向**包根**（不是 internal）。
# -InternalDir 是本脚本所在目录（internal）。
$PackageRoot = $AppDir
$InternalDir = Split-Path -Parent $PSCommandPath
if (-not (Test-Path (Join-Path $InternalDir 'node.exe'))) { $InternalDir = $AppDir }   # 兜底：被单独拿出来跑

$Node = Join-Path $InternalDir 'node.exe'
$LogDir = Join-Path $PackageRoot 'logs'
$PidFile = Join-Path $PackageRoot '.running.pid'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# ── 日志写入 ────────────────────────────────────────────────────────
# 用 -Encoding Default（中文 Windows 上就是 ANSI/GBK）。
# 为什么不用 UTF8：PowerShell 5.1 的 -Encoding UTF8 会写出带 BOM 的文件，
# 而子进程（node）被 Start-Process 重定向时是按系统 ANSI 写的。两种编码混在
# 一个日志目录里，用户用记事本打开会看到乱码。统一 ANSI 后与子进程一致。
function Write-Log($name, $msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path (Join-Path $LogDir "$name.log") -Value $line -Encoding Default
}

# ── 单实例保护 ──────────────────────────────────────────────────────
# 没有这道检查时，用户连点两次「启动」会起两个托盘，而两个托盘各自管一套
# 子进程：一个抢到 7239 端口，另一个的接收端起不来就会触发自愈反复重启，
# 日志刷屏、行为难以解释。所以启动前先看有没有已经跑着的。
# 两条检测取并集（只看 PID 文件不够：强杀后文件会残留成假阳性）。
function Find-ExistingTray {
  $found = @()
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like '*tray.ps1*' } |
    Where-Object { $_.ProcessId -ne $PID } |
    ForEach-Object { $found += [int]$_.ProcessId }
  if (Test-Path $PidFile) {
    $old = 0
    [void][int]::TryParse((Get-Content $PidFile -Raw -EA SilentlyContinue).Trim(), [ref]$old)
    if ($old -gt 0 -and $old -ne $PID) {
      if (Get-Process -Id $old -EA SilentlyContinue) { $found += $old }
    }
  }
  return ($found | Sort-Object -Unique)
}

$existing = @(Find-ExistingTray)
if ($existing.Count -gt 0) {
  Write-Log 'tray' ("已有实例在运行（PID {0}），本次启动退出" -f ($existing -join ', '))
  [System.Windows.Forms.MessageBox]::Show(
    ("CoRead 已经在运行了（进程号 " + ($existing -join ', ') + "）。" + [Environment]::NewLine + [Environment]::NewLine +
     "请看屏幕右下角托盘里的图标。" + [Environment]::NewLine +
     "右键那个图标可以退出 CoRead，退出后再重新启动即可。"),
    'CoRead', 'OK', 'Information') | Out-Null
  exit 0
}

# ── 拉起一个子进程 ──────────────────────────────────────────────────
# 用 Start-Process 直接起 node.exe，并把输出重定向到日志文件。
# 路径相对**包根**给（internal\agent\index.js），因为 node 会按脚本自身位置
# 推导数据目录，所以数据落在 <包根>\data\ 下。
function Start-Child($name, $scriptRelPath) {
  $script = Join-Path $PackageRoot $scriptRelPath
  if (-not (Test-Path $script)) { Write-Log 'tray' "找不到 $scriptRelPath，跳过"; return $null }
  $outLog = Join-Path $LogDir "$name.out.log"
  $errLog = Join-Path $LogDir "$name.err.log"
  Write-Log $name "启动: $scriptRelPath"
  try {
    $p = Start-Process -FilePath $Node -ArgumentList @($script) `
      -WorkingDirectory $PackageRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-Log $name "PID $($p.Id)"
    return $p
  } catch {
    Write-Log $name "启动失败: $($_.Exception.Message)"
    return $null
  }
}

# ── 端口检查：7239 是否已被别人占用 ─────────────────────────────────
# 为什么要查：用户可能之前用开发方式（start.bat）起过一份接收端还没关。
# 那种情况下我们这份接收端会因端口冲突立刻退出，自愈逻辑又不断重启它，
# 看起来像"坏了"。所以显式检测并给出明确提示。
function Get-PortOwner([int]$port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {}
  return 0
}

function Test-PortConflict {
  $owner = Get-PortOwner 7239
  if ($owner -eq 0) { return $false }
  $mine = Get-CoreadProcesses | Where-Object { $_.ProcessId -eq $owner }
  return (-not $mine)
}

function Get-CoreadProcesses {
  # 只认"用我们这个 node.exe 跑的"进程，避免误杀用户其他 node 程序
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $Node }
}

function Stop-All {
  # 优雅停机：给 agent 写 .stop 哨兵，它会保存记忆后自己退出
  $stopFile = Join-Path $PackageRoot 'data\agent\.stop'
  try {
    $dir = Split-Path -Parent $stopFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
  } catch {}
  Write-Log 'tray' '.stop 哨兵已写入，等待 agent 保存记忆…'
  Start-Sleep -Seconds 3
  foreach ($p in (Get-CoreadProcesses)) {
    Write-Log 'tray' "结束 PID $($p.ProcessId) ($($p.Name))"
    Stop-Process -Id $p.ProcessId -Force -EA SilentlyContinue
  }
  Remove-Item $stopFile -Force -EA SilentlyContinue
  Remove-Item $PidFile -Force -EA SilentlyContinue
}

function Get-Status {
  if (Test-PortConflict) { return 'port-conflict' }
  $procs = @(Get-CoreadProcesses)
  if ($procs.Count -eq 0) { return 'stopped' }
  $hasReceiver = $procs | Where-Object { $_.CommandLine -like '*receiver*' }
  $hasAgent = $procs | Where-Object { $_.CommandLine -like '*agent*' }
  if ($hasReceiver -and $hasAgent) { return 'running' }
  if ($hasReceiver) { return 'receiver-only' }
  return 'partial'
}

# ── 启动 ────────────────────────────────────────────────────────────
if (-not (Test-Path $Node)) {
  [System.Windows.Forms.MessageBox]::Show(
    ("找不到 node.exe：" + [Environment]::NewLine + $Node + [Environment]::NewLine + [Environment]::NewLine +
     "安装似乎不完整，请重新解压整个压缩包。"),
    'CoRead 启动失败', 'OK', 'Error') | Out-Null
  exit 1
}

Set-Content -Path $PidFile -Value $PID -Encoding ASCII

if (Test-PortConflict) {
  # 端口被别人的程序占着（常见于"之前用 start.bat 起过一份还在跑"）。
  # 这时不要拉起接收端——它起来也会立刻因端口冲突退出，然后被自愈反复重启。
  $owner = Get-PortOwner 7239
  Write-Log 'tray' "端口 7239 已被 PID $owner 占用（不是本程序启动的进程），跳过接收端"
  Start-Child 'agent' 'internal\agent\index.js' | Out-Null
  [System.Windows.Forms.MessageBox]::Show(
    ("端口 7239 已被另一个程序占用，CoRead 的接收端无法启动。" + [Environment]::NewLine + [Environment]::NewLine +
     "最常见的原因：你之前用 start.bat 启动过一份 CoRead，它还在运行。" + [Environment]::NewLine +
     "请先运行 stop.bat（或右键托盘图标退出），再重新启动 CoRead。"),
    'CoRead：端口被占用', 'OK', 'Warning') | Out-Null
} else {
  Start-Child 'receiver' 'internal\receiver\index.js' | Out-Null
  Start-Sleep -Milliseconds 1200          # 让接收端先占好端口
  Start-Child 'agent' 'internal\agent\index.js' | Out-Null
}
Write-Log 'tray' '已启动'

# ── 托盘图标与菜单 ──────────────────────────────────────────────────
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = 'CoRead 共读'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStatus.Text = '状态：启动中…'
$itemStatus.Enabled = $false
$menu.Items.Add($itemStatus) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$itemOpen.Text = '打开微信读书'
$itemOpen.add_Click({ Start-Process 'https://weread.qq.com/' })
$menu.Items.Add($itemOpen) | Out-Null

$itemExt = New-Object System.Windows.Forms.ToolStripMenuItem
$itemExt.Text = '打开插件文件夹（装插件时用）'
$itemExt.add_Click({ Start-Process 'explorer.exe' (Join-Path $PackageRoot 'extension') })
$menu.Items.Add($itemExt) | Out-Null

$itemData = New-Object System.Windows.Forms.ToolStripMenuItem
$itemData.Text = '打开数据文件夹（我的记录）'
# 数据目录是代码里写死的，位置跟着代码走：agent 的数据在 internal\agent\data。
# 这里直接定位到那个文件夹——对用户来说"打开就能看到我的记录"才是重点，
# 不需要他知道为什么它在 internal 下面。
$itemData.add_Click({ Start-Process 'explorer.exe' (Join-Path $PackageRoot 'internal\agent\data') })
$menu.Items.Add($itemData) | Out-Null

$itemLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$itemLogs.Text = '查看日志（出错时看这里）'
$itemLogs.add_Click({ Start-Process 'explorer.exe' $LogDir })
$menu.Items.Add($itemLogs) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$itemQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemQuit.Text = '退出 CoRead'
$itemQuit.add_Click({
  $script:quitting = $true          # 先置位，避免自愈逻辑在退出途中又把进程拉起来
  $timer.Stop()
  $notify.Text = 'CoRead 正在退出…'
  Stop-All
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($itemQuit) | Out-Null

$notify.ContextMenuStrip = $menu

# 双击托盘图标 = 打开微信读书
$notify.add_DoubleClick({ Start-Process 'https://weread.qq.com/' })

# ── 状态刷新 + 崩溃自愈 ─────────────────────────────────────────────
$script:lastRestart = @{}
$script:quitting = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $st = Get-Status
  switch ($st) {
    'running'       { $notify.Text = 'CoRead 运行中';              $itemStatus.Text = '状态：运行中 ✅' }
    'receiver-only' { $notify.Text = 'CoRead 部分运行（引擎未起）';  $itemStatus.Text = '状态：引擎未运行 ⚠️' }
    'partial'       { $notify.Text = 'CoRead 部分运行';             $itemStatus.Text = '状态：部分运行 ⚠️' }
    'port-conflict' { $notify.Text = 'CoRead：端口 7239 被占用';    $itemStatus.Text = '状态：端口被占用 ❌（先跑 stop.bat）' }
    default         { $notify.Text = 'CoRead 已停止';               $itemStatus.Text = '状态：已停止' }
  }
  # 崩溃自愈：不在退出流程里、且某一半掉了，就补起来（最多每 30 秒一次）
  # 端口被占用时不自愈——重启多少次都没用，只会在日志里刷屏
  if (-not $script:quitting -and $st -ne 'port-conflict') {
    $now = Get-Date
    if ($st -eq 'receiver-only') {
      $last = $script:lastRestart['agent']
      if (-not $last -or ($now - $last).TotalSeconds -gt 30) {
        Write-Log 'tray' '检测到 agent 未运行，尝试重启'
        Start-Child 'agent' 'internal\agent\index.js' | Out-Null
        $script:lastRestart['agent'] = $now
      }
    } elseif ($st -eq 'stopped') {
      $last = $script:lastRestart['all']
      if (-not $last -or ($now - $last).TotalSeconds -gt 30) {
        Write-Log 'tray' '检测到两个进程都未运行，尝试重启'
        Start-Child 'receiver' 'internal\receiver\index.js' | Out-Null
        Start-Sleep -Milliseconds 1200
        Start-Child 'agent' 'internal\agent\index.js' | Out-Null
        $script:lastRestart['all'] = $now
      }
    }
  }
})
$timer.Start()

# 首次启动时给个气泡提示
$notify.BalloonTipTitle = 'CoRead 已启动'
$notify.BalloonTipText = '打开微信读书即可开始共读。右键这个图标可以退出。'
$notify.ShowBalloonTip(4000)

# ── 主循环 ──────────────────────────────────────────────────────────
[System.Windows.Forms.Application]::Run()
