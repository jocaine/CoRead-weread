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
# ── 自己起的孩子，自己记住 ──────────────────────────────────────────
# 2026-10-07：以前 Start-Child 的返回值被六处 `| Out-Null` 丢掉，于是看门狗只能靠
# `Get-CimInstance` 扫全机进程 + **猜命令行文本**来"认亲"。那条路依赖权限、会被安全
# 软件拦（实测：受限环境里 CIM 连自己的进程都查不到）。一旦它瞎了，看门狗就以为 agent
# 掉了，于是**又拉一个** —— 两个 agent 同时回同一条消息，用户看到的就是"被回复两次"。
# 现在把句柄留着：问 $p.HasExited 就够，可靠、不需要任何权限、不受安全软件影响。
$script:children = @{ agent = $null; receiver = $null }

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
    $script:children[$name] = $p
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

# 某个孩子还活着吗？（2026-10-07）
# 优先问我们自己的句柄 —— 可靠、不需要任何权限、不受安全软件影响。
# 只有拿不到句柄时（脚本缺失、启动失败等）才回退到扫 WMI，并**宁可不动作**：
# 那条路看不见时会把活着的进程当成死的，而看门狗"以为死了"的后果是多拉一个 agent。
function Test-ChildAlive([string]$name) {
  $p = $script:children[$name]
  if ($p) {
    try { if (-not $p.HasExited) { return $true } } catch {}
    return $false      # 句柄有效且已退出 = 确定死了，不必再问 WMI
  }
  return (@(Get-CoreadProcesses | Where-Object { $_.CommandLine -like "*$name*" }).Count -gt 0)
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
  $hasReceiver = Test-ChildAlive 'receiver'
  $hasAgent = Test-ChildAlive 'agent'
  if ($hasReceiver -and $hasAgent) { return 'running' }
  if ($hasReceiver) { return 'receiver-only' }
  if ($hasAgent) { return 'partial' }
  return 'stopped'
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
# ── CoRead 自己的阅读器（2026-10：托盘里也要能直接进）──────────────────
# 阅读器是**浏览器插件自己的页面**，地址形如 chrome-extension://<扩展ID>/reader.html。
#
# ── 那个 ID 从哪来 ──────────────────────────────────────────────────────
# 它是扩展目录**绝对路径**的 SHA256 前 16 字节（十六进制再把 0-9a-f 映射成 a-p）。
# 算法固定、可复现，本机自己就算得出来 —— 不需要问任何人。实测对账过两次：
#   C:\Users\lengdrug\CoRead-weread\extension → bjoeiphhecggpckaiekpigobpffdgjmo（与 Chrome 记的一致）
#   E:\coRead\extension                       → ocfjjjjhhiikpabdadcppobakffidgfb（与 Edge 记的一致）
# 所以：**换个目录装，ID 就变**。这意味着拿"某个固定文件里的 ID"当唯一依据是错的
# （第一版就这么设计，结果那份文件一旦缺失、浏览器又一直开着，就再也没机会补上，
# 功能整个断掉）。现在一律**按各自路径现算**，算不出来才回退读 data\runtime\extension-id。
function Get-ExtensionIdFromPath([string]$Dir) {
  if (-not $Dir -or -not (Test-Path $Dir)) { return '' }
  try {
    # ⚠️ Chrome 是对路径的 **UTF-16LE** 字节做 SHA256（.NET 的 Unicode 编码就是这个），
    #    不是 UTF-8。用错编码算出来的是一串同样像模像样的 32 位 ID，但打不开任何东西 ——
    #    这个坑没有报错、只有"页面不存在"，所以别改这一行。
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
             [Text.Encoding]::Unicode.GetBytes($Dir))
    $hex = -join ($sha[0..15] | ForEach-Object { $_.ToString('x2') })
    $alphabet = 'abcdefghijklmnop'
    $id = -join ($hex.ToCharArray() | ForEach-Object { $alphabet[[Convert]::ToInt32($_, 16)] })
    if ($id -cnotmatch '^[a-p]{32}$') { return '' }   # 形状自检（大小写敏感）
    return $id
  } catch { return '' }
}

# 按 exe 文件名找浏览器：先查 App Paths（Chrome 与 Edge 安装时都会登记，值是完整路径，
# **装到 D 盘也照样准确**），再扫卸载项里登记的安装目录，最后试常见安装路径。
function Find-BrowserByExeName([string]$exeName) {
  foreach ($root in 'HKCU:', 'HKLM:') {
    $k = "$root\Software\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
    try {
      if (Test-Path $k) {
        $v = (Get-ItemProperty $k -Name '(default)' -EA SilentlyContinue).'(default)'
        if ($v -and (Test-Path $v)) { return $v }
      }
    } catch {}
  }
  try {
    $roots = @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($item in (Get-ItemProperty $roots -EA SilentlyContinue)) {
      if (-not $item.InstallLocation) { continue }
      $hit = Get-ChildItem -LiteralPath $item.InstallLocation -Filter $exeName -Recurse -File -Depth 2 -EA SilentlyContinue |
             Select-Object -First 1
      if ($hit) { return $hit.FullName }
    }
  } catch {}
  foreach ($c in @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\$exeName"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\$exeName"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\$exeName"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\$exeName"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\$exeName")
  )) { if ($c -and (Test-Path $c)) { return $c } }
  return ''
}


# 列出某个浏览器 profile 里**所有未打包扩展**的 (ID, 安装路径)。
#
# 为什么要有这个"笨"函数（2026-10-07 用户提出"我 Edge 和 Chrome 都装了"）：
# 早先的做法是"拿本包算出的 ID 去这个 profile 里找"——那只认**从本包目录加载**的那一份。
# 实测本机：Chrome 加载的是本仓库那份，Edge 加载的是 E:\coRead 那份便携包，
# 两者的 ID 根本不是同一个 —— 于是 Edge 被彻底漏掉，用户想用 Edge 都用不了。
# 现在改成"把这个浏览器装了哪些本地扩展**全列出来**，再按路径判断谁是我们"，
# 这样无论 CoRead 是从哪个目录加载的、装了几份，都能认出来。
#
# ⚠️ 下面这几条是实测踩出来的，改之前先读：
#   · 文件是**单行巨型 JSON**（实测 245 KB 一行），所以一律全文匹配，不能按行找；
#   · `"path"` 用非贪婪匹配会撞上条目内部**嵌套的** path 字段（preferences /
#     content_settings 里就有），必须先把每个 `"<ID>":{…}` 的花括号配对圈出来再取。
function Get-InstalledUnpackedExtensions([string]$ProfDir) {
  $pref = Join-Path $ProfDir 'Secure Preferences'
  if (-not (Test-Path $pref)) { return @() }
  $raw = ''
  try {
    $fs = [IO.File]::Open($pref, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { $sr = New-Object IO.StreamReader($fs); $raw = $sr.ReadToEnd() } finally { $fs.Dispose() }
  } catch { return @() }
  if (-not $raw) { return @() }
  $out = @()
  foreach ($m in [regex]::Matches($raw, '"([a-p]{32})"\s*:\s*\{')) {
    $id = $m.Groups[1].Value
    $brace = $raw.IndexOf('{', $m.Index)
    if ($brace -lt 0) { continue }
    $depth = 0; $end = -1
    for ($k = $brace; $k -lt $raw.Length; $k++) {
      $c = $raw[$k]
      if ($c -eq '{') { $depth++ }
      elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { $end = $k; break } }
    }
    if ($end -le $brace) { continue }
    $body = $raw.Substring($brace, $end - $brace + 1)
    # 只认"未打包扩展"（location:4）—— 商店装的扩展没有可读的 path，也不是我们这份
    if (-not $body.Contains('"location":4')) { continue }
    $pm = [regex]::Match($body, '"path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $pm.Success) { continue }
    $p = ($pm.Groups[1].Value -replace '\\\\', '\')
    if ($p) { $out += @{ Id = $id; Path = $p } }
  }
  return $out
}

# 找出这台机器上"哪些浏览器装了 CoRead"。返回数组，每项：
#   @{ Key; Name; Exe; ExtId; Profile; Updated; Path }
#
# 判定依据是**扩展的安装路径**，不是"某个固定 ID"：
#   · 路径里带 CoRead（`\coread\`、`\CoRead-0.3.1-portable\` …）→ 就是我；
#   · 或路径等于我们自己的两个可能安装目录（本包根、本包的 internal\）。
# 为什么必须这样（2026-10-07 实测踩到）：同一份插件可以从**不同目录**加载到不同浏览器，
# 而 ID 是按目录路径算的 —— 本机 Chrome 装的是本仓库那份（bjoeiph…），
# Edge 装的是 E:\coRead 那份便携包（ocfjjj…），**两个 ID 根本不一样**。
# 早先拿"本包算出的 ID"去找，结果 Edge 被彻底漏掉（用户想用 Edge 都用不了）。
function Get-ReaderBrowsers {
  $map = @(
    @{ key = 'chrome';   name = 'Chrome';   local = 'Google\Chrome\User Data';               exe = 'chrome.exe' }
    @{ key = 'edge';     name = 'Edge';     local = 'Microsoft\Edge\User Data';              exe = 'msedge.exe' }
    @{ key = 'brave';    name = 'Brave';    local = 'BraveSoftware\Brave-Browser\User Data'; exe = 'brave.exe' }
    @{ key = 'vivaldi';  name = 'Vivaldi';  local = 'Vivaldi\User Data';                     exe = 'vivaldi.exe' }
    @{ key = 'chromium'; name = 'Chromium'; local = 'Chromium\User Data';                    exe = 'chrome.exe' }
    @{ key = 'liebao';   name = '猎豹';     local = 'liebao\User Data';                      exe = 'liebao.exe' }
    @{ key = '360';      name = '360极速';  local = '360Chrome\Chrome\User Data';            exe = '360chrome.exe' }
    @{ key = 'qq';       name = 'QQ浏览器'; local = 'Tencent\QQBrowser\User Data';           exe = 'QQBrowser.exe' }
    @{ key = 'sogou';    name = '搜狗';     local = 'SogouExplorer\User Data';               exe = 'SogouExplorer.exe' }
  )
  # 我们自己可能的安装目录（便携包是 <包根>\extension，仓库是同一层）
  $ours = @()
  foreach ($d in @((Join-Path $PackageRoot 'extension'), (Join-Path $PackageRoot 'internal\extension'))) {
    if (Test-Path $d) { $ours += $d.TrimEnd('\').ToLower() }
  }
  $out = @()
  foreach ($b in $map) {
    $ud = Join-Path $env:LOCALAPPDATA $b.local
    if (-not (Test-Path $ud)) { continue }
    $exe = Find-BrowserByExeName $b.exe
    if (-not $exe) { continue }                    # exe 找不到就没法打开，别浪费时间翻清单
    $profs = @()
    if (Test-Path (Join-Path $ud 'Default')) { $profs += (Join-Path $ud 'Default') }
    $profs += @(Get-ChildItem (Join-Path $ud 'Profile *') -Directory -EA SilentlyContinue |
                 Select-Object -ExpandProperty FullName)
    foreach ($pd in $profs) {
      foreach ($ext in (Get-InstalledUnpackedExtensions $pd)) {
        $p = $ext.Path.TrimEnd('\')
        $pl = $p.ToLower()
        $isOurs = ($ours -contains $pl) -or $pl.Contains('\coread') -or $pl.Contains('\co-read')
        if (-not $isOurs) { continue }
        $updated = ''
        try { $updated = (Get-Item $p -EA SilentlyContinue).LastWriteTime.ToString('yyyy-MM-dd') } catch {}
        $out += @{
          Key = $b.key; Name = $b.name; Exe = $exe; ExtId = $ext.Id
          Profile = [IO.Path]::GetFileName($pd); Updated = $updated; Path = $p
        }
        break                                       # 一个 profile 里认一个就够
      }
    }
  }
  return $out
}

# ── 用哪个浏览器打开：记在 data\config\reader-browser.txt ────────────────
# 为什么要有这个设置（2026-10-07 用户提出"两个都装了怎么办"）：
#   Chrome 与 Edge 都装了插件时没有唯一正确答案 —— 只能用户说了算。
#   而**多份安装的阅读进度是各存各的**（译文与读到第几页存在那个浏览器的
#   chrome.storage.local 里），所以这个选择有实际后果，不能随机挑。
# 放 data\config\ 的理由：那正是"设置"这一格，与模型 API 配置同级；
# 而且文件是纯文本带注释，用户想手改也知道写什么。
function Get-ReaderBrowserPref {
  $f = Join-Path $PackageRoot 'data\config\reader-browser.txt'
  if (-not (Test-Path $f)) { return '' }
  $lines = @()
  try { $lines = [IO.File]::ReadAllLines($f) } catch { return '' }
  foreach ($ln in $lines) {
    $t = $ln.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    return $t.Trim('"').Trim("'").ToLower()
  }
  return ''
}
function Set-ReaderBrowserPref([string]$Key) {
  $f = Join-Path $PackageRoot 'data\config\reader-browser.txt'
  try {
    $dir = Split-Path -Parent $f
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $txt = @(
      '# CoRead 用哪个浏览器打开自己的阅读器（写出名字即可，程序只读非注释行）',
      '# 可选值：chrome / edge / brave / vivaldi / chromium / liebao / 360 / qq / sogou',
      '# 删掉这个文件（或删掉下面那行）→ 恢复"每次列出来让你选"（只有一个可用时自动用它）。',
      '# 为什么需要它：Chrome 与 Edge 都装了插件时没有唯一答案；而且两边的阅读进度',
      '# （译文、读到第几页）是各存各的，所以选哪个是有后果的。',
      $Key
    )
    [IO.File]::WriteAllLines($f, $txt, (New-Object System.Text.UTF8Encoding($false)))
    return $true
  } catch {
    Write-Log 'tray' "写 reader-browser.txt 失败: $($_.Exception.Message)"
    return $false
  }
}

# 当前该用哪个浏览器（结果放 $script:readerPick，同时把 $script:browserSource 写好）
function Resolve-ReaderBrowser {
  $list = Get-ReaderBrowsers
  $script:readerBrowsers = $list
  $script:readerPick = $null
  if (-not $list -or $list.Count -eq 0) {
    $script:browserSource = '清单里没有任何浏览器装着本插件'
    return $null
  }
  # ① 用户指定过的
  $pref = Get-ReaderBrowserPref
  if ($pref) {
    $hit = $list | Where-Object { $_.Key -eq $pref -or $_.Name.ToLower() -eq $pref } | Select-Object -First 1
    if ($hit) { $script:browserSource = "你指定过用 $($hit.Name)"; $script:readerPick = $hit; return $hit }
    Write-Log 'tray' "设置里写的 $pref 没装着本插件，改回让你选"
  }
  # ② 只有一个可用 → 直接用它（大多数用户是这种，不该被打扰）
  if ($list.Count -eq 1) {
    $script:browserSource = "只有 $($list[0].Name) 装着本插件"
    $script:readerPick = $list[0]
    return $list[0]
  }
  # ③ 多个可用 → 让用户选，并把选择记下来
  $msg = "CoRead 插件在下面这些浏览器里都装着，用哪一个打开阅读器？"
  $msg += [Environment]::NewLine + "选定后会记住，下次直接用它（想换：右键托盘图标 →「阅读器用哪个浏览器」）。"
  $msg += [Environment]::NewLine
  foreach ($it in $list) {
    $msg += [Environment]::NewLine + "  · $($it.Name)（$($it.Profile)）"
    if ($it.Updated) { $msg += "  插件更新于 $($it.Updated)" }
  }
  $msg += [Environment]::NewLine + [Environment]::NewLine + "注意：两边的阅读进度（译文、读到第几页）各存各的，选哪个会影响你看到的进度。"
  $msg += [Environment]::NewLine + "按「是」用第一个，按「否」用最后一个。"
  $r = [System.Windows.Forms.MessageBox]::Show($msg, 'CoRead 阅读器：用哪个浏览器？', 'YesNo', 'Question')
  if ($r -eq 'Yes') { $script:readerPick = $list[0] } else { $script:readerPick = $list[$list.Count - 1] }
  $script:browserSource = "你刚选的（共 $($list.Count) 个可用）"
  Set-ReaderBrowserPref $script:readerPick.Key | Out-Null
  return $script:readerPick
}

# 阅读器打不开时的说明。
# 为什么不悄悄改成打开微信读书：用户点的就是"我自己的阅读器"，目标被偷偷换掉，
# 行为不可预测 —— 而真正该说的解决办法本来就得说出来。
function Show-ReaderHint([string]$Why) {
  $msg = @(
    '托盘没能打开 CoRead 阅读器。可能的原因：'
    ''
    '· 插件还没在任何浏览器里加载过 → 在浏览器工具栏点一下 CoRead 图标（拼图块形状），'
    '  或者打开一次微信读书网页版；'
    '· extension 目录被挪了位置或改了名 → 插件编号是按目录路径算的，路径变了编号就变，'
    '  浏览器里那份要重新「加载已解压的扩展程序」选一次（托盘会重新认出来）。'
  ) -join [Environment]::NewLine
  if ($Why) { $msg += ([Environment]::NewLine + [Environment]::NewLine + $Why) }
  [System.Windows.Forms.MessageBox]::Show($msg, 'CoRead 阅读器', 'OK', 'Information') | Out-Null
}

# 打开阅读器：**交给浏览器 exe**（不走协议关联，理由见下面那一段注释），地址按该浏览器的 ID 现拼。
function Open-Reader {
  $pick = Resolve-ReaderBrowser
  if (-not $pick) {
    Write-Log 'tray' "打不开 CoRead 阅读器：没有任何浏览器装着本插件（$($script:browserSource)）"
    Show-ReaderHint ''
    return
  }
  $url = "chrome-extension://$($pick.ExtId)/reader.html"
  try {
    Start-Process -FilePath $pick.Exe -ArgumentList @($url)
    Write-Log 'tray' "已打开 CoRead 阅读器（$($pick.Name) / $($pick.Exe)；选择依据：$($script:browserSource)）"
  } catch {
    Write-Log 'tray' "打开 CoRead 阅读器失败: $($_.Exception.Message)"
    Show-ReaderHint ("系统没能用这个浏览器打开地址：" + $pick.Exe)
  }
}

# ── 找浏览器：不要交给 Windows 去猜（2026-10-07 实测踩到）────────────────
# 踩的坑：早先直接 Start-Process 'chrome-extension://…'。但那要求 Windows 注册表里
# 有 chrome-extension 这个协议的**关联程序**，而实测本机：
#     HKCU\...\UrlAssociations\chrome-extension\UserChoice  → 不存在
#     HKLM/HKCU\SOFTWARE\Classes\chrome-extension*          → 一个都没有
# 也就是说 Windows 根本不认识这个协议。于是它按"找能打开它的应用"处理，
# **弹出「你要如何打开?」并把人送去微软商店** —— 用户看到的就是这个。
# 而且它不报错（Start-Process 不抛异常），所以当时的 catch 兜底永远不会触发。
# 正解就是上面那样：自己定位浏览器 exe，把地址当命令行参数传给它。
#
# 另一个坑：**"默认浏览器"不等于"装着插件的浏览器"**。实测本机默认浏览器是猎豹
# （D:\liebao\liebao.exe），而插件装在 Chrome 与 Edge 里 —— 按默认浏览器打开，
# 只会得到一个"找不到扩展程序"的错误页。所以挑浏览器一律以"谁装了插件"为准
# （Get-ReaderBrowsers 翻的就是各浏览器自己的插件清单），默认浏览器从来不参与。

# 状态变量：开机先扫一遍，供右键菜单里的「阅读器用哪个浏览器」用（点那些菜单项会重扫）
$script:readerBrowsers = @()
$script:readerPick = $null
$script:browserSource = ''


# 扫描一次并刷新右键菜单里「阅读器用哪个浏览器」那一栏。
# 为什么每次点菜单都重扫、而不是启动时扫一次：用户完全可能装着托盘的时候去装插件、
# 或把某份扩展删掉。重扫一次的成本是读几个几百 KB 的文件（实测整轮约 400 ms），
# 只在打开菜单/点这一栏时发生，不值得为它缓存出"菜单状态与事实不符"的问题。
function Update-ReaderBrowserMenu {
  $list = Get-ReaderBrowsers
  $script:readerBrowsers = $list
  $pref = Get-ReaderBrowserPref
  # 子菜单的子项挂在 **DropDownItems** 上 —— ToolStripMenuItem.Items 是 null（实测），
  # 顶层菜单（ContextMenuStrip）才用 .Items。写错的表现是点开这一项直接报 null 异常。
  $script:readerMenu.DropDownItems.Clear()
  if (-not $list -or $list.Count -eq 0) {
    $none = New-Object System.Windows.Forms.ToolStripMenuItem
    $none.Text = '（没找到装着 CoRead 插件的浏览器）'
    $none.Enabled = $false
    $script:readerMenu.DropDownItems.Add($none) | Out-Null
    return
  }
  $pickKey = ''
  if ($pref) {
    $hit = $list | Where-Object { $_.Key -eq $pref -or $_.Name.ToLower() -eq $pref } | Select-Object -First 1
    if ($hit) { $pickKey = $hit.Key }
  }
  foreach ($it in $list) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem
    # 在用的那个打勾。勾是"当前设置"，不是"默认值"—— 只有一个可用时我们自动用它，也算在用。
    $mi.Text = $(if ($it.Key -eq $pickKey) { "✔ $($it.Name)" } else { "   $($it.Name)" })
    $mi.ToolTipText = "$($it.ExtId)`r`n来自：$($it.Path)"
    # 闭包捕获：$it 是循环变量，事件触发时循环早已结束，不 GetNewClosure 会全部指向最后一个。
    # （这是 PowerShell 的经典坑：不写它，"选 Edge"实际会把偏好写成最后那项。）
    $mi.add_Click({ Set-ReaderBrowserPref $it.Key | Out-Null; Update-ReaderBrowserMenu }.GetNewClosure())
    $script:readerMenu.DropDownItems.Add($mi) | Out-Null
  }
  $script:readerMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $auto = New-Object System.Windows.Forms.ToolStripMenuItem
  $auto.Text = '每次让我选（清掉设置）'
  # 删掉偏好文件 = 回到"每次都问"，与文件里写的说明一致
  $auto.add_Click({ Remove-Item (Join-Path $PackageRoot 'data\config\reader-browser.txt') -Force -EA SilentlyContinue; Update-ReaderBrowserMenu })
  $script:readerMenu.DropDownItems.Add($auto) | Out-Null
  $again = New-Object System.Windows.Forms.ToolStripMenuItem
  $again.Text = '重新检测'
  $again.add_Click({ Update-ReaderBrowserMenu })
  $script:readerMenu.DropDownItems.Add($again) | Out-Null
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = Get-TrayIcon
# ⚠️ NotifyIcon.Text（图标名，不是下面那个气泡）有 **63 个字符**的硬上限，超了会直接抛
# ArgumentException 让托盘起不来。现在这个 11 字的写法离上限很远，但**别在这条上堆文案**：
# 想加说明就加到右键菜单项或气泡里（那两处没有这个限制）。
$notify.Text = 'CoRead 共读'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStatus.Text = '状态：启动中…'
$itemStatus.Enabled = $false
$menu.Items.Add($itemStatus) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# ── 两个阅读入口：自己的排第一（2026-10 用户定调）──────────────────────
# 刻意把「打开 CoRead 阅读器」放在微信读书**上面**：自己那个是本程序的阅读器，
# 打开它才是"用 CoRead 读书"；微信读书那条是给"我就要在微读的划线里共读"的用户留的。
# 名字里都带"阅读"二字，但前面那个必须点明是 CoRead 自己的，否则两个条目分不清谁是谁。
$itemReader = New-Object System.Windows.Forms.ToolStripMenuItem
$itemReader.Text = '打开 CoRead 阅读器（推荐）'
$itemReader.add_Click({ Open-Reader })
$menu.Items.Add($itemReader) | Out-Null

# 阅读器用哪个浏览器（2026-10-07 用户提出"Edge 和 Chrome 都装了怎么办"）
# 常驻菜单栏而不是"只在多选时才出现"：否则有得选的人反而发现不了入口。
$readerMenu = New-Object System.Windows.Forms.ToolStripMenuItem
$readerMenu.Text = '阅读器用哪个浏览器'
Update-ReaderBrowserMenu      # 开机先填一次；之后选完 或 点「重新检测」都会刷新
$menu.Items.Add($readerMenu) | Out-Null

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

# 双击托盘图标 = 打开 CoRead 阅读器（推荐的那个动作）。
# 2026-10 改：以前双击是打开微信读书。改成自己的阅读器，是为了让"双击图标"这个
# 最顺手的动作落在 CoRead 自己身上；微信读书仍在右键菜单第二项，没被拿走。
# 拿不到扩展 ID 时 Open-Reader 会弹窗说明怎么让它可用，不会静默失败。
$notify.add_DoubleClick({ Open-Reader })

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
  #
  # 2026-10-07 两处改动：
  #   ① 判据从"扫 WMI 认亲"改成问句柄（Test-ChildAlive）——那条路一旦瞎了，
  #      看门狗会把活着的 agent 当成死的，于是**多拉一个**，两个 agent 同时回话。
  #   ② 节流键合并：以前 'agent' 与 'all' 各算各的，所以 30 秒拦不住连着拉
  #      （实测 15:19:30 与 15:19:50 两次，间隔 20 秒）。
  if (-not $script:quitting -and $st -ne 'port-conflict') {
    if (-not (Test-ChildAlive 'receiver') -or -not (Test-ChildAlive 'agent')) {
      $now = Get-Date
      $last = $script:lastRestart['any']
      if (-not $last -or ($now - $last).TotalSeconds -gt 30) {
        if (-not (Test-ChildAlive 'receiver')) {
          Write-Log 'tray' '检测到 receiver 未运行，尝试重启'
          Start-Child 'receiver' $ReceiverScript | Out-Null
          Start-Sleep -Milliseconds 1200     # 让接收端先占好端口
        }
        if (-not (Test-ChildAlive 'agent')) {
          Write-Log 'tray' '检测到 agent 未运行，尝试重启'
          Start-Child 'agent' $AgentScript | Out-Null
        }
        $script:lastRestart['any'] = $now
      }
    }
  }
})
$timer.Start()

# 首次启动时给个气泡提示。
# 气泡是"该去哪儿读书"这句话唯一的落点（菜单要右键才看见），所以两个入口都点名，
# 并把 CoRead 自己的阅读器放在前面 —— 用户没读说明书时，这里就是他看到的全部指引。
# NotifyIcon 的气泡正文有长度上限（超过 ~250 字会被截断），这一句要压着写。
$notify.BalloonTipTitle = 'CoRead 已启动'
$notify.BalloonTipText = '双击这个图标打开 CoRead 阅读器（推荐）。想读微信读书就右键图标选它。右键可退出。'
$notify.ShowBalloonTip(4000)

# ── 主循环 ──────────────────────────────────────────────────────────
[System.Windows.Forms.Application]::Run()
