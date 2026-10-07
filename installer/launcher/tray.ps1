# CoRead 托盘程序
#
# 为什么用 PowerShell 而不是编译一个 exe：
#   Windows 自带 PowerShell 和 WinForms，能直接做托盘图标 + 右键菜单，
#   不需要额外运行时、不需要编译、不需要签名。体积为零。
# 这个文件是"临时托盘"，接口刻意留成可替换的：
#   将来换成正式的托盘 exe，只要保证同样的行为（拉起两个进程、能停、能看日志）即可。

param(
  [string]$AppDir = (Split-Path -Parent $PSCommandPath),
  [string]$NodeExe = ''
  # 这里原来还有一个 [switch]$AutoStart —— 2026-10 删掉：它声明了但**全项目没有
  # 一处使用**（也没有任何代码写注册表自启项），而说明书却三处承诺"会写开机自启项"，
  # 其中一处还拿它当作"杀软为什么报警"的解释。留着死参数比删掉更危险：它会让下一个
  # 读代码的人以为自启已经实现，于是继续把文档留在错的状态。
  # 要真做自启功能时再加回来，并且必须同时补一个"关掉自启"的入口。
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# WinForms 视觉样式（按钮/文本框走系统主题，而不是老的灰底 3D 样子）。
# 必须在**创建任何控件之前**调用，所以放在这儿 —— 后面才会建 NotifyIcon。
# 托盘右键菜单是 .NET 自绘的（ContextMenuStrip 有自己的渲染器），不受这句影响；
# 这一句是为「装浏览器插件」那个自建窗体加的：不开它，窗体里的按钮会显得很旧。
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── 目录约定（两种布局都支持，自动判断）─────────────────────────────
# 便携包布局（读者用的）：
#   <包根>\            用户看到的：data\、logs\、extension\、README-FIRST.txt
#   <包根>\internal\   程序自己用的：node.exe、tray.ps1、Start-CoRead.vbs、agent\、receiver\
#   <包根>\data\       用户数据（config/profile/sessions/reading/runtime/toolbox/backups）
#   <包根>\builtin\    空目录（2026-10 起不再随包分发图谱文件；不是用户数据）
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
# 日志刷屏、行为难以解释。
#
# 2026-10-07 换成**具名互斥体**（named mutex）。旧做法是"扫进程命令行 + 读
# .running.pid，两条取并集"，三条都不成立：
#   1. **不是原子的**：两个进程几乎同时启动时，双方都在对方登记之前查完 → 双双放行。
#      单实例必须由内核的原子操作裁决，不能"先看看有没有人，再起"。
#   2. **PID 文件不是锁**：进程被强杀后文件残留，等 Windows 把那个编号复用给别的
#      进程，下次启动就会看到"这个 PID 活着"而**拒绝启动**。误拒比误放更糟：
#      误放有端口冲突检测兜底；误拒只会让用户以为程序坏了（而且弹窗把原因指向端口）。
#   3. **判据写死了 powershell.exe**：哪天改用 pwsh 启动，检测会静默失效 —— 不报错，
#      只是再也挡不住第二个实例。
# 互斥体由内核保证原子：同时创建只有一个进程拿到 createdNew=$true。进程无论怎么退出
# （正常、强杀、崩溃），内核都会在最后一个句柄关闭时销毁它 —— 不留文件、没有残留、
# 没有编号复用问题。命名空间用 Local\ 而不是 Global\：Global\ 需要
# SeCreateGlobalPrivilege，普通用户没有（会直接抛权限错），而"同一会话里连点两次"
# 正是要挡的场景。
$mutexCreatedNew = $false
try {
  # 句柄一直持有到进程结束（故意不 ReleaseMutex：对象存在本身就是"已有实例在跑"）
  $script:trayMutex = [System.Threading.Mutex]::new($false, 'Local\CoReadTray', [ref]$mutexCreatedNew)
} catch {
  # 宁可漏挡，也不要因为这道检查本身出错而起不来
  Write-Log 'tray' ("单实例互斥体创建失败，跳过这道检查继续启动：" + $_.Exception.Message)
  $mutexCreatedNew = $true
}
if (-not $mutexCreatedNew) {
  Write-Log 'tray' '已有实例在运行（具名互斥体 Local\CoReadTray 已存在），本次启动退出'
  [System.Windows.Forms.MessageBox]::Show(
    ("CoRead 已经在运行了。" + [Environment]::NewLine + [Environment]::NewLine +
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
# 生成脚本 tools\make-icons.ps1 已于 2026-10-07 删除（要改图标就从 git 历史取回它）。
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

# ── 装插件指引窗体（自建、**非模态**；2026-10 用户要求可换样式）────────────
# 为什么不用系统 MessageBox（下面每条都是实测结论）：
#   · 它是**模态**的 —— 开着的时候托盘那个 5 秒崩溃自愈轮询整个停摆；
#   · 它的文字**不能选中、也不能复制** —— 用户切到浏览器点几下，剪贴板被别的
#     东西盖掉，就只能照着屏幕一个字一个字敲这个路径；
#   · 样式一概改不了（实测枚举只有：按钮组合 / 图标 / 默认按钮；
#     字体、字号、颜色、布局、连按钮文字都写死）；
#   · 更现代的 TaskDialog 在 PowerShell 5.1 上**不存在** —— 它是 .NET 5+ 才进
#     WinForms 的，这里 GetType('System.Windows.Forms.TaskDialog') 返回 null。
#     要用就得额外带一个 DLL，违背"体积为零、不装额外运行时"这个前提。
# 自建窗体换来三件事：① 非模态，不挡自愈轮询；② 路径放只读文本框，可选中、
# 可再次 Ctrl+C；③ 多一个「复制路径」按钮，随时能再复制一次。
#
# 两处刻意选择：
#   · 置顶 + 显示在任务栏 —— 用户接下来要在浏览器里操作，这个窗口是"照着填"
#     的参考，既不能被浏览器盖住，也不能让他找不到。
#   · 不放 emoji —— 系统 UI 字体不一定有 emoji 字形，会渲染成方框（豆腐块），
#     所以文案里用文字描述"拼图块形状的图标"。
#
# ⚠️ 按钮的处理器**只能**用 $script: 作用域去拿控件（实测，别改成局部变量）：
#    嵌在别的处理器内部的脚本块，在事件循环里被调用时**看不到**外层的局部变量
#    （同步触发会因为动态作用域"看起来能用"，是假阳性）；
#    而 `.GetNewClosure()` 里的 $script: 指向 closure 自己的模块作用域，写不回来。
#    所以下面用 $script:extHelpPath / $script:extHelpStatus 这两个中间变量。
#
# 版式为什么拆成一堆标签（2026-10 用户反馈"排版乱、不清爽"）：
#   第一版把整段说明塞进**一个** Label，靠手打空格做缩进 —— 中英文字宽不同，
#   空格根本对不齐；而且所有文字同字号、同灰度，没有层级，看起来就是一坨。
#   现在：每一步各自成标签、坐标是真实像素列（不会再歪）；标题 / 正文 / 注解
#   用三种字重 + 两种灰度分层，层级不靠堆空行。
# 高度为什么取两种口径的较大值（实测数字，别简化成一个）：
#   · TextRenderer.MeasureText → 文字**墨迹**高度（长文本还知道换几行）
#   · Label.PreferredHeight    → Label 按**行高**算的高度
#   实测（微软雅黑）：13pt 粗体 墨迹 25 / 行高 28；9pt 粗体 17 / 20；8.5pt 17 / 19。
#   只取前者，粗体上会少 1~3px —— 中文没有下伸部溢出所以**看不出来**，
#   换个字体或系统就可能把最后一行切掉。只取后者则长文本换行时可能不够。取大的。
function Add-HelpLabel($Form, [string]$Text, [int]$X, [int]$Y, [int]$W, $Font, $Color) {
  $l = New-Object System.Windows.Forms.Label
  $l.AutoSize = $false
  $l.Text = $Text
  $l.Font = $Font
  $l.ForeColor = $Color
  $l.Location = New-Object System.Drawing.Point($X, $Y)
  $l.Size = New-Object System.Drawing.Size($W, 10)     # 先定宽；高度下面按量出来的改
  $hMeas = [System.Windows.Forms.TextRenderer]::MeasureText(
             $Text, $Font, (New-Object System.Drawing.Size($W, 4000)),
             [System.Windows.Forms.TextFormatFlags]::WordBreak).Height
  $l.Size = New-Object System.Drawing.Size($W, [Math]::Max($hMeas, $l.PreferredHeight))
  $Form.Controls.Add($l)
  return $l.Size.Height
}

function Show-ExtensionHelp([string]$ExtDir, [bool]$Copied) {
  # 已经开着就直接拉到前面，不再开第二个窗口
  $prev = $script:extHelpForm
  if ($prev -and -not $prev.IsDisposed) {
    $prev.Activate()
    $prev.BringToFront()
    return
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'CoRead · 安装浏览器插件'
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowInTaskbar = $true
  $form.TopMost = $true
  # 字体：优先"微软雅黑"，取不到就用系统默认（系统默认靠字体链接也能正常显示
  # 中文 —— 系统 MessageBox 就是这么显示的）。不硬依赖某个字体名。
  try { $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9) } catch { }
  try { $form.Icon = Get-TrayIcon } catch { }

  # ── 版式常量：所有坐标都从这几个数推出来，不散落魔数 ────────────────
  $margin = 20                       # 左右边距
  $w      = 540                      # 内容总宽
  $numW   = 24                       # 步骤序号列宽
  $bodyX  = $margin + $numW          # 正文左边缘：悬垂缩进，正文对齐在标题下方
  $bodyW  = $w - $numW
  $y      = 18                       # 纵向游标：控件自上而下排，末尾按实际高度定窗体

  # 三层字重 + 两种灰度做层级：标题 > 正文 > 注解
  $fBase  = $form.Font
  $fTitle = New-Object System.Drawing.Font($fBase.FontFamily, ($fBase.Size + 4), [System.Drawing.FontStyle]::Bold)
  $fBold  = New-Object System.Drawing.Font($fBase, [System.Drawing.FontStyle]::Bold)
  $fSmall = New-Object System.Drawing.Font($fBase.FontFamily, ($fBase.Size - 0.5))
  $cText  = [System.Drawing.SystemColors]::ControlText
  $cGray  = [System.Drawing.SystemColors]::GrayText

  # ── 文案原则（2026-10 用户要求）────────────────────────────────────
  # ① 不假设用户用 Chrome："扩展程序管理页"的地址各家不同（chrome:// / edge:// /
  #    brave:// / …），列不完，所以只教**每家都存在的动作**，不给地址。
  # ② 按钮名各浏览器不同（Edge 上就不叫「加载已解压的扩展程序」），所以说明它的
  #    **作用**（选择一个本地文件夹），措辞差异就不会卡住人。
  # ③ 不放 emoji —— 系统 UI 字体不一定有 emoji 字形，会渲染成方框（豆腐块）。
  # ④ 书面语，不用聊天口气（第一版是"只需要装一次""找不到它，就点…"）。
  $steps = @(
    @{ n = '1'; t = '打开扩展程序管理页'
       d = @('地址栏右侧的扩展程序图标 →「管理扩展程序」',
             '或：浏览器菜单 →「扩展程序」') }
    @{ n = '2'; t = '开启「开发者模式」'
       d = @() }
    @{ n = '3'; t = '点击「加载已解压的扩展程序」'
       d = @('在弹出的目录选择框中粘贴下方路径。',
             '各浏览器按钮名称略有差异，作用均为选择一个本地文件夹。') }
  )

  $y += (Add-HelpLabel $form '安装浏览器插件' $margin $y $w $fTitle $cText) + 4
  $y += (Add-HelpLabel $form '仅需安装一次。适用于 Chrome 内核的浏览器（Chrome、Edge 等）；Firefox 不适用。' $margin $y $w $fSmall $cGray) + 18

  foreach ($s in $steps) {
    # 序号在固定宽度的列里右对齐；高度取标题那一行的高度 → 自然垂直居中
    $hT = Add-HelpLabel $form $s.t $bodyX $y $bodyW $fBold $cText
    $num = New-Object System.Windows.Forms.Label
    $num.Text = $s.n
    $num.Font = $fBold
    $num.ForeColor = $cGray
    $num.TextAlign = 'MiddleRight'
    $num.Location = New-Object System.Drawing.Point($margin, $y)
    $num.Size = New-Object System.Drawing.Size(($numW - 6), $hT)
    $form.Controls.Add($num)
    $y += $hT + 3
    foreach ($line in $s.d) {
      $y += (Add-HelpLabel $form $line $bodyX $y $bodyW $fSmall $cGray) + 2
    }
    $y += 12
  }

  # ── 路径：标签 + 只读文本框 + 状态行 ────────────────────────────────
  $y += (Add-HelpLabel $form '插件目录' $margin $y $w $fBold $cText) + 4

  # 只读文本框：能选中、能 Ctrl+C，但改不了。只读时系统会把它画成灰底
  # （看起来像"禁用"），所以把底色改回窗口色 —— 它是"内容"，不是"不可用"。
  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Text = $ExtDir
  $txt.ReadOnly = $true
  $txt.Location = New-Object System.Drawing.Point($margin, $y)
  $txt.Size = New-Object System.Drawing.Size($w, 25)
  $txt.BackColor = [System.Drawing.SystemColors]::Window
  $form.Controls.Add($txt)
  $y += 25 + 10

  $status = New-Object System.Windows.Forms.Label
  $status.Font = $fSmall
  $status.ForeColor = $cGray
  $status.Location = New-Object System.Drawing.Point($margin, $y)
  $status.Size = New-Object System.Drawing.Size(330, 20)
  if ($Copied) { $status.Text = '路径已复制到剪贴板。' }
  else { $status.Text = '剪贴板不可用：请选中上方路径后按 Ctrl+C。' }
  $form.Controls.Add($status)
  $y += 20 + 12

  $btnCopy = New-Object System.Windows.Forms.Button
  $btnCopy.Text = '复制路径'
  $btnCopy.Location = New-Object System.Drawing.Point(($margin + $w - 212), $y)
  $btnCopy.Size = New-Object System.Drawing.Size(100, 32)
  $btnCopy.add_Click({
    try {
      [System.Windows.Forms.Clipboard]::SetDataObject($script:extHelpPath.Text, $true)
      $script:extHelpStatus.Text = '已复制到剪贴板。'
    } catch {
      $script:extHelpStatus.Text = '复制失败：请选中上方路径后按 Ctrl+C。'
    }
  })
  $form.Controls.Add($btnCopy)

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.Text = '关闭'
  $btnClose.Location = New-Object System.Drawing.Point(($margin + $w - 100), $y)
  $btnClose.Size = New-Object System.Drawing.Size(100, 32)
  $btnClose.add_Click({ $script:extHelpForm.Close() })
  $form.Controls.Add($btnClose)

  $y += 32 + 18
  $form.ClientSize = New-Object System.Drawing.Size(($margin * 2 + $w), $y)

  $form.add_FormClosed({
    $script:extHelpForm = $null
    $script:extHelpPath = $null
    $script:extHelpStatus = $null
  })

  $script:extHelpForm = $form
  $script:extHelpPath = $txt
  $script:extHelpStatus = $status
  $form.Show()      # Show = 非模态；ShowDialog = 模态（会挡住自愈轮询，别用）
  $form.Activate()
}

$itemExt = New-Object System.Windows.Forms.ToolStripMenuItem
$itemExt.Text = '装浏览器插件（只需一次）'
# 2026-10 改：这一项以前叫「打开插件文件夹（装插件时用）」，只是把 extension\ 打开。
# 那是个错的动作 —— 用户要装插件，需要的是"这个目录**在哪**"，不是"里面有什么"：
#   · Chrome 的「加载已解压的扩展程序」只认磁盘上的目录，不能从 zip 装；
#   · 也不能把文件夹拖到扩展页上装（拖拽只对 .crx 安装包有效）——
#     所以用户必须让那个**目录选择框**定位到这个目录；
#   · 而 extension\ 里 22 个顶层项全是源码（manifest.json、sidebar.js、
#     vendor\ 里还有 205 个 PDF.js 文件），没有任何一个是"装我"。
#     打开它，用户反而站在目录**里面**，更不知道自己站在哪一层。
# 所以这里做三件事：路径进剪贴板（选择框粘贴+回车直接跳过去）、
# 资源管理器定位（/select 开**父目录**并选中它，旁边就是 README-FIRST.txt）、
# 三步说明。菜单文案也一并改成按**任务**命名（「装浏览器插件」）而不是按文件夹命名。
$itemExt.add_Click({
  $extDir = Join-Path $PackageRoot 'extension'
  if (-not (Test-Path $extDir)) {
    [System.Windows.Forms.MessageBox]::Show(
      ("找不到插件目录：" + [Environment]::NewLine + $extDir),
      'CoRead', 'OK', 'Warning') | Out-Null
    return
  }

  # 先判断指引窗体是不是已经开着 —— 它决定后面做哪几件事。
  # 实测（2026-10）：同一项点两次时 explorer /select **会再开一个窗口**，
  # 不会复用已有的那个。所以"已开着"这个判断必须放在 ② 之前，
  # 否则重复点会越点越多窗口（第一次写成放在 ③，实测就是 2 个窗口）。
  $prev = $script:extHelpForm
  $alreadyOpen = [bool]($prev -and -not $prev.IsDisposed)

  # ① 路径进剪贴板。必须用带 $true 的重载：第二个参数 = 进程退出后剪贴板内容仍在，
  #    否则托盘一关，用户刚复制的东西就没了（SetText 的默认行为就是不持久）。
  #    重复点这一项时也要重做一遍 —— 那正是用户此刻的意图（剪贴板被别的东西盖了）。
  $copied = $false
  try {
    [System.Windows.Forms.Clipboard]::SetDataObject($extDir, $true)
    $copied = $true
  } catch {
    Write-Log 'tray' "复制插件路径到剪贴板失败: $($_.Exception.Message)"
  }

  # ② /select 打开父目录并选中 extension（不是打开它本身 —— 见上方注释）。
  #    只在第一次开：重复点不再堆资源管理器窗口。
  if (-not $alreadyOpen) {
    Start-Process 'explorer.exe' "/select,`"$extDir`""
  }

  # ③ 显示安装指引。文案与窗体都在 Show-ExtensionHelp 里（唯一真源）。
  if ($alreadyOpen) {
    $prev.Activate()
    $prev.BringToFront()
    Write-Log 'tray' '插件安装指引已在显示：重新复制了路径并拉到前面'
    return
  }

  try {
    Show-ExtensionHelp -ExtDir $extDir -Copied $copied
    Write-Log 'tray' "已打开插件安装指引（路径已复制: $copied）"
  } catch {
    # 兜底：窗体建不出来（极端情况）也不能让用户什么都没看到
    Write-Log 'tray' "自建指引窗体失败，退回系统弹窗: $($_.Exception.Message)"
    [System.Windows.Forms.MessageBox]::Show(
      ('安装浏览器插件，三步：' + [Environment]::NewLine +
       '  1. 打开扩展程序管理页（扩展程序图标，或浏览器菜单 →「扩展程序」）' + [Environment]::NewLine +
       '  2. 开启「开发者模式」' + [Environment]::NewLine +
       '  3. 点击「加载已解压的扩展程序」，选择该目录：' + [Environment]::NewLine +
       '     ' + $extDir),
      'CoRead · 安装浏览器插件', 'OK', 'Information') | Out-Null
  }
})
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
