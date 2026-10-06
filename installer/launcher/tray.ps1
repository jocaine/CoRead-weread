# CoRead 托盘程序
#
# 为什么用 PowerShell 而不是编译一个 exe：
#   Windows 自带 PowerShell 和 WinForms，能直接做托盘图标 + 右键菜单，
#   不需要额外运行时、不需要编译、不需要签名。体积为零。
# 这个文件是"临时托盘"，接口刻意留成可替换的：
#   将来换成正式的托盘 exe，只要保证同样的行为（拉起两个进程、能停、能看日志）即可。

param(
  [string]$AppDir = (Split-Path -Parent $PSCommandPath),
  [string]$NodeExe = '',
  [switch]$AutoStart
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 目录约定（两种布局都支持，自动判断）─────────────────────────────
# 便携包布局（读者用的）：
#   <包根>\            用户看到的：data\、logs\、extension\、README-FIRST.txt
#   <包根>\internal\   程序自己用的：node.exe、tray.ps1、Start-CoRead.vbs、agent\、receiver\
#   <包根>\data\       用户数据（config/profile/sessions/reading/runtime/toolbox/backups）
#   <包根>\builtin\    随包分发的内置图谱（不是用户数据）
#
# 开发布局（仓库根）：
#   <仓库根>\          同样的 data\、logs\、extension\
#   <仓库根>\agent\     程序直接在根下（没有 internal\ 这一层）
#   <仓库根>\receiver\
#   <仓库根>\Start-CoRead.vbs              双击入口（与包里同名）
#   <仓库根>\installer\launcher\tray.ps1   ← 本文件在这儿
#
# **同一份脚本、同一个入口，两种布局共用**（2026-10 定调）。为什么值得这么做：
# 开发期跑的启动/停止路径因此与发行版**完全一致** —— 优雅停机（写哨兵→等 agent
# 自退→关库）、端口冲突检测、崩溃自愈，这些以前在开发时永远走不到，于是
# "托盘退出的哨兵写错地方、导致从来没有优雅过"这种 bug 能藏两个月（见 Stop-All）。
#
# 判定规则只有一条：**程序目录里有没有 node.exe**。
#   有（便携包自带 node.exe）→ 便携包布局，程序在 internal\，根 = 上一级
#   没有（开发机用 PATH 里的 node）→ 开发布局，程序就在根下，node 走 PATH
# 数据路径不在这里拼：agent\lib\paths.js 用同一个信号（父目录叫不叫 internal）判断，
# 两边必须一致 —— 改这里就要改那里。
$PackageRoot = $AppDir
$InternalDir = Split-Path -Parent $PSCommandPath      # internal（便携包）或 installer\launcher（开发）
$IsPortable = Test-Path (Join-Path $InternalDir 'node.exe')
if (-not $IsPortable) {
  if (-not (Test-Path (Join-Path $PackageRoot 'agent\index.js'))) {
    [System.Windows.Forms.MessageBox]::Show(
      ("既没有 internal\node.exe，也没有 agent\index.js。" + [Environment]::NewLine +
       "程序目录不像一个完整的 CoRead：" + [Environment]::NewLine + $PackageRoot),
      'CoRead 启动失败', 'OK', 'Error') | Out-Null
    exit 1
  }
  $InternalDir = $PackageRoot                          # 开发布局：程序直接就在根下
}
$LayoutKind = if ($IsPortable) { 'package' } else { 'dev' }   # 只用于日志/提示文案
# 子进程脚本路径：便携包在 internal\ 下，开发目录直接在根下
$AgentScript = if ($IsPortable) { 'internal\agent\index.js' } else { 'agent\index.js' }
$ReceiverScript = if ($IsPortable) { 'internal\receiver\index.js' } else { 'receiver\index.js' }

# Node 可执行文件：便携包用自带的，开发机用 PATH 里的 node（-NodeExe 可显式覆盖）
if ($NodeExe) { $Node = $NodeExe }
elseif ($IsPortable) { $Node = Join-Path $InternalDir 'node.exe' }
else { $Node = 'node' }

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
# 脚本路径相对**包根**给（internal\agent\index.js）：agent/lib/paths.js 按脚本自身位置
# 判断"装没装在 internal 下"，进而定位 <包根>\data\ —— 所以这个相对关系不能改。
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
  # 只认"我们自己启动的" node 进程，避免误杀用户其他 node 程序。
  # 便携包：按可执行文件路径精确比对（自带 internal\node.exe）。
  # 开发布局：用的是 PATH 里的 node，没有独占路径可比，改按命令行匹配我们的入口脚本
  #          （agent\index.js / receiver\index.js）——比裸的 '*index.js*' 窄得多，
  #          不会误伤同目录下跑的其他工具脚本。
  if ($IsPortable) {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $Node }
  } else {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
      Where-Object {
        $_.CommandLine -like "*$AgentScript*" -or $_.CommandLine -like "*$ReceiverScript*"
      }
  }
}

function Stop-All {
  # 优雅停机：写哨兵文件，agent 轮询到就保存记忆再自己退出。
  #
  # ⚠️ 这个路径**必须**与 agent/lib/paths.js 里的 STOP_FILE 一致：
  #     <包根>\data\sessions\stop-request
  # 2026-10 修过一个 bug：这里原来写的是 <包根>\data\agent\.stop，而 agent 查的是
  # internal\agent\.stop（当时数据路径还跟着代码走）——两边对不上，于是"托盘右键退出"
  # 从来没有触发过优雅停机，日志里永远是写入哨兵后 3 秒强杀，最后一场对话的记忆不固化
  # （实测日志：18:19:51 写哨兵 → 18:19:54 结束进程）。顺带这行还凭空造了一个
  # <包根>\data\agent\ 空目录，正是 README 里说"不要去造"的那种误导性空壳。
  # 数据路径改成 data\ 统一目录后，这里只需跟着 STOP_FILE 走一次；改路径时**同时**改
  # agent/lib/paths.js 和 installer\launcher\stop.bat。
  $stopFile = Join-Path $PackageRoot 'data\sessions\stop-request'
  try {
    $dir = Split-Path -Parent $stopFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
  } catch {}
  Write-Log 'tray' '已请求 agent 保存记忆（等待它自己退出）…'

  # 等 agent **进程**结束，而不是等哨兵文件消失。
  # 为什么：agent 的退出顺序是「先保存记忆 → 删哨兵 → 关聊天库 → 退出」（见 agent/index.js
  # 的优雅停机分支）。如果盯着哨兵，会在它刚删完哨兵、还没关库的时候就动手强杀——
  # 那正好破坏了"干净退出"（-wal 不搬回主库）。盯进程才是真的等它收尾。
  # 一次记忆固化要调一次 LLM，可能几十秒，所以给到 90 秒——与 stop.bat 同口径。
  # 以前这里是写死 3 秒强杀，等于白写哨兵。
  $agentProc = Get-CoreadProcesses | Where-Object { $_.CommandLine -like '*agent*' } | Select-Object -First 1
  $waited = 0
  $agentExited = $true          # 没有 agent 在跑时也算"已退出"
  if ($agentProc) {
    $agentHandle = Get-Process -Id $agentProc.ProcessId -EA SilentlyContinue
    if ($agentHandle) {
      $agentExited = $false
      while (-not $agentExited -and $waited -lt 90) {
        Start-Sleep -Seconds 3
        $waited += 3
        try { $agentExited = $agentHandle.HasExited } catch { $agentExited = $true }
      }
    }
  }
  if ($agentProc -and -not $agentExited) {
    Write-Log 'tray' "等待 $waited 秒仍未结束，强制停止（进行中的讨论留在讨论栈里，不会丢）"
  } elseif ($agentProc) {
    Write-Log 'tray' "agent 已完成记忆保存并退出（用时约 $waited 秒）"
  } else {
    Write-Log 'tray' '没有发现运行中的 agent，直接停止其余进程'
  }

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
# 便携包：检查自带的 node.exe 在不在（不在 = 包不完整）。
# 开发布局：$Node 是 'node'，得去 PATH 里找；找不到就提示装 Node。
if ($IsPortable) {
  if (-not (Test-Path $Node)) {
    [System.Windows.Forms.MessageBox]::Show(
      ("找不到 node.exe：" + [Environment]::NewLine + $Node + [Environment]::NewLine + [Environment]::NewLine +
       "安装似乎不完整，请重新解压整个压缩包。"),
      'CoRead 启动失败', 'OK', 'Error') | Out-Null
    exit 1
  }
} else {
  $nodeCmd = Get-Command $Node -EA SilentlyContinue
  if (-not $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show(
      ("开发布局下需要 PATH 里有 node（找不到 '$Node'）。" + [Environment]::NewLine + [Environment]::NewLine +
       "装一个 Node 24+，或用 -NodeExe 指定完整路径。" ),
      'CoRead 启动失败', 'OK', 'Error') | Out-Null
    exit 1
  }
}

Set-Content -Path $PidFile -Value $PID -Encoding ASCII

if (Test-PortConflict) {
  # 端口被别人的程序占着（最常见：另一个 CoRead 实例还在跑 —— 便携包与开发目录
  # 都用 7239，同时只能跑一个）。
  # 这时不要拉起接收端——它起来也会立刻因端口冲突退出，然后被自愈反复重启。
  $owner = Get-PortOwner 7239
  Write-Log 'tray' "端口 7239 已被 PID $owner 占用（不是本程序启动的进程），跳过接收端"
  Start-Child 'agent' $AgentScript | Out-Null
  [System.Windows.Forms.MessageBox]::Show(
    ("端口 7239 已被另一个程序占用，CoRead 的接收端无法启动。" + [Environment]::NewLine + [Environment]::NewLine +
     "最常见的原因：另一个 CoRead 还在运行（便携包与开发目录共用这个端口，" + [Environment]::NewLine +
     "同时只能跑一个）。请从那个实例的托盘点「退出 CoRead」，再启动这个。"),
    'CoRead：端口被占用', 'OK', 'Warning') | Out-Null
} else {
  Start-Child 'receiver' $ReceiverScript | Out-Null
  Start-Sleep -Milliseconds 1200          # 让接收端先占好端口
  Start-Child 'agent' $AgentScript | Out-Null
}
Write-Log 'tray' "已启动（$LayoutKind 布局，node = $Node）"

# ── 托盘图标与菜单 ──────────────────────────────────────────────────
# 图标文件：assets\icons\coread.ico（含 16/32/48/128/256 五个尺寸，Windows 会挑合适的）。
# 生成脚本 tools\make-icons.ps1，随包分发时必须一起带上 —— 找不到就退回系统默认图标，
# 不报错（图标是锦上添花，不该因为它缺失让程序起不来）。
function Get-TrayIcon {
  $candidates = @(
    (Join-Path $PackageRoot 'assets\icons\coread.ico'),
    (Join-Path $PackageRoot 'installer\build\portable\assets\icons\coread.ico')
  )
  foreach ($p in $candidates) {
    try {
      if (Test-Path $p) { return (New-Object System.Drawing.Icon($p)) }
    } catch {}
  }
  try {
    $p = Join-Path $PackageRoot 'assets\icons\icon32.png'
    if (Test-Path $p) {
      $bmp = [System.Drawing.Image]::FromFile($p)
      $h = $bmp.GetHicon()
      $bmp.Dispose()
      return [System.Drawing.Icon]::FromHandle($h)
    }
  } catch {}
  return [System.Drawing.SystemIcons]::Application
}
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = Get-TrayIcon
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
# 2026-10 目录重构后，数据就在包根的 data\（与 internal\ 同级）。
# 这个路径由 agent\lib\paths.js 决定；改那里就要改这里。
$itemData.add_Click({ Start-Process 'explorer.exe' (Join-Path $PackageRoot 'data') })
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
    'port-conflict' { $notify.Text = 'CoRead：端口 7239 被占用';    $itemStatus.Text = '状态：端口被占用 ❌（另一个实例在跑？）' }
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
        Start-Child 'agent' $AgentScript | Out-Null
        $script:lastRestart['agent'] = $now
      }
    } elseif ($st -eq 'stopped') {
      $last = $script:lastRestart['all']
      if (-not $last -or ($now - $last).TotalSeconds -gt 30) {
        Write-Log 'tray' '检测到两个进程都未运行，尝试重启'
        Start-Child 'receiver' $ReceiverScript | Out-Null
        Start-Sleep -Milliseconds 1200
        Start-Child 'agent' $AgentScript | Out-Null
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
