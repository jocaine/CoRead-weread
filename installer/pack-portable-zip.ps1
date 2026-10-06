# 生成免安装的便携包（zip）——**当前唯一的分发包形态**
#
# 曾经还有一个走 Inno Setup 的 .exe 安装包（pack-portable.ps1 + co-read.iss + build-installer.bat），
# 2026-10-06 连同那几个脚本一起删掉了：未数字签名被火绒 HIPS 拦，且它省下的只是
# "解压 + 双击"两步（装插件无论如何都得用户手动做）。原因与当年的踩坑记录见
# distribution-design.md §6.5；需要恢复就从 git 历史取（删前最后提交 498d8f5）。
#
# 这个脚本产出一个"解压即用"的 zip：用户自己解压，程序不碰 %TEMP%、不写注册表，
# 被安全软件拦的概率低得多。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File installer\pack-portable-zip.ps1
#
# 产物：installer\build\out\CoRead-<版本>-portable.zip

param(
  [string]$StageDir = (Join-Path $PSScriptRoot 'build\portable'),
  [string]$OutDir   = (Join-Path $PSScriptRoot 'build\out'),
  [string]$NodeVersion = 'v24.15.0',
  [string]$NodeDir = '',
  # 是否生成 desktop.ini 中文显示名。
  # 默认关闭：实测 zip 解压会丢掉文件夹属性，desktop.ini 因此不被读取，
  # 显示名不生效；更糟的是属性丢失后它会从"隐藏"变成"可见"，用户解压完
  # 会看到一堆莫名其妙的 desktop.ini，比不加更乱。
  # 只有换成自解压包（能跑"解压后脚本"补属性）时才该打开这个开关。
  [switch]$WriteFolderLabels
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Write-Step($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "[错误] $m" -ForegroundColor Red; exit 1 }

Write-Host "`n=== CoRead 便携包 ===" -ForegroundColor Cyan
Write-Host "仓库: $repo"
Write-Host "输出: $OutDir`n"

# ── 0. 仓库里的 .ps1 必须带 UTF-8 BOM（先查，别等打包到一半才炸）──────
# 为什么：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当系统 ANSI（中文 Windows 是 GBK）解析，
# 脚本里的中文会整体乱码、语法直接崩，而且报错位置完全是错的（实测把中文注释当成了
# 字符串没闭合）。编辑器"保存"经常把 BOM 吞掉——本项目已经因此踩过三次。
# 这里只**检查并中止**，不自动补：自动补会掩盖"某个编辑器正在吃掉 BOM"这个事实。
$noBom = @()
foreach ($ps1 in Get-ChildItem $repo -Recurse -File -Filter '*.ps1' -EA SilentlyContinue |
                  Where-Object { $_.FullName -notmatch '\\installer\\build\\|\\node_modules\\|\\\.git\\' }) {
  $b = [System.IO.File]::ReadAllBytes($ps1.FullName)
  $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  if (-not $hasBom) { $noBom += $ps1.FullName }
}
if ($noBom.Count) {
  Write-Host '❌ 下列 .ps1 缺少 UTF-8 BOM，打包中止：' -ForegroundColor Red
  $noBom | ForEach-Object { Write-Host "   $($_.Replace($repo + '\', ''))" }
  Write-Host ''
  Write-Host '   原因：无 BOM 的 UTF-8 会被 PowerShell 5.1 当 GBK 读，中文注释会让脚本语法崩。'
  Write-Host '   修法：用支持 UTF-8 BOM 的编辑器另存，或跑：'
  Write-Host '     $b=[IO.File]::ReadAllBytes($f); [IO.File]::WriteAllBytes($f, ([byte[]](0xEF,0xBB,0xBF)+$b))'
  exit 1
}
Write-Host '✅ 仓库内 .ps1 均带 UTF-8 BOM'

# ── 0b. 仓库里的 .bat / .vbs 必须纯 ASCII（同样先查，别等打包到一半）──────
# 为什么：cmd.exe 与 Windows Script Host 按系统 ANSI（中文 Windows 是 GBK）读文件，
# 非 ASCII 会变乱码；cmd 还是边读边执行，乱码行会被当成命令去跑
# （实测：中文注释被拆成 'is' / 'step' / 'emory' 之类的命令，满屏报错）。
# 中文说明一律放 .txt / .md。
$nonAscii = @()
foreach ($bf in Get-ChildItem $repo -Recurse -File -Include '*.bat', '*.vbs' -EA SilentlyContinue |
                   Where-Object { $_.FullName -notmatch '\\installer\\build\\|\\node_modules\\|\\\.git\\' }) {
  $bytes = [System.IO.File]::ReadAllBytes($bf.FullName)
  $bad = 0
  foreach ($b in $bytes) { if ($b -gt 127) { $bad++ } }
  if ($bad -gt 0) { $nonAscii += "$($bf.FullName.Replace($repo + '\', ''))（$bad 个非 ASCII 字节）" }
}
if ($nonAscii.Count) {
  Write-Host '❌ 下列 .bat / .vbs 含非 ASCII 字节，打包中止：' -ForegroundColor Red
  $nonAscii | ForEach-Object { Write-Host "   $_" }
  Write-Host ''
  Write-Host '   原因：cmd / WSH 按系统 ANSI 读取，中文会变乱码并被当作命令执行。'
  Write-Host '   修法：把这些文件里的中文改成英文，中文说明写到 .txt / .md 里。'
  exit 1
}
Write-Host '✅ 仓库内 .bat / .vbs 均为纯 ASCII'

# ── 版本号：从插件 manifest 读，保证一致 ────────────────────────────
$manifest = Join-Path $repo 'extension\manifest.json'
if (-not (Test-Path $manifest)) { Fail "找不到 extension\manifest.json" }
$ver = (Get-Content $manifest -Raw | ConvertFrom-Json).version
if (-not $ver) { Fail '没能从 manifest 读出 version' }
Write-Host "插件版本: $ver`n"

# ── 1. 干净暂存目录 ─────────────────────────────────────────────────
# 先检查有没有正在运行的 CoRead 占着这些目录。
# 为什么要查：如果用户正从暂存目录/输出目录跑 CoRead，它会把
# receiver\inbox\chat.db 和 logs\*.log 锁住，Remove-Item 会**静默失败**
# （-Force 不报错），于是删不干净、旧文件留在包里，而构建看起来"成功"。
# 实测踩过：一次构建后图省事直接从 build\out 启动，下次打包就删不掉了。
function Find-RunningFromSubdir {
  # 只认真正在跑的 CoRead，两类，判据都要够严：
  #   1) node.exe，且**可执行文件本身**就在构建目录里（用 ExecutablePath 精确判断）
  #   2) powershell 跑的托盘：命令行里有 -File 和 tray.ps1
  # 之前判据写得太宽（命令行里出现 "node.exe" 字样就算），结果把临时进程、
  # 甚至调用本脚本的 PowerShell 自己都算成了占用 —— 误报过一次，白等一轮。
  $hits = @()
  foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue)) {
    $exe = $proc.ExecutablePath
    if ($exe -and ($exe -like "$StageDir*" -or $exe -like "$OutDir*")) {
      $hits += "PID $($proc.ProcessId) (node.exe $exe)"
    }
  }
  foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue)) {
    $cl = $proc.CommandLine
    if (-not $cl) { continue }
    if ($cl -like '*-File*tray.ps1*' -and ($cl -like "*$StageDir*" -or $cl -like "*$OutDir*")) {
      $hits += "PID $($proc.ProcessId) (托盘)"
    }
  }
  return $hits
}

$running = Find-RunningFromSubdir
if ($running.Count -gt 0) {
  Write-Host '❌ 检测到 CoRead 正在暂存目录/输出目录里运行，无法安全重建：' -ForegroundColor Red
  $running | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
  Write-Host ''
  Write-Host '   请先退出 CoRead（右键托盘图标 → 退出 CoRead），或运行 stop.bat，然后重试。' -ForegroundColor Yellow
  Write-Host '   另：建议把便携包解压到别处（如 D:\CoRead）再运行，' -ForegroundColor Yellow
  Write-Host '       不要直接从 build 目录启动——那个目录每次构建都会被清掉。' -ForegroundColor Yellow
  exit 1
}

if (Test-Path $StageDir) {
  Remove-Item $StageDir -Recurse -Force -EA SilentlyContinue
  # 确认真的删干净了（-Force 对占用文件是静默失败）
  if (Test-Path $StageDir) {
    $left = @(Get-ChildItem $StageDir -Recurse -Force -EA SilentlyContinue).Count
    Write-Host "❌ 暂存目录删不干净（还剩 $left 项），可能有进程占用。" -ForegroundColor Red
    Write-Host "   $StageDir" -ForegroundColor Red
    Write-Host '   请退出 CoRead 后重试。' -ForegroundColor Yellow
    exit 1
  }
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

# ── 2. 建立两层结构 ─────────────────────────────────────────────────
# 为什么这么分：用户打开文件夹时应该一眼看出"我只需要碰哪几个"。
# 最外层只留四样：
#     data\            ← 你的全部数据（备份就复制这一个文件夹）
#     extension\       ← 浏览器插件（装插件时必须选它）
#     internal\        ← 程序本体（Node 运行环境、引擎、接收端、说明书）
#     几个 .bat / 说明  ← 双击启动、出问题看说明
# 另有 builtin\（随包分发的内置图谱）与 logs\（日志），两者都不是用户数据。
# 数据能从 internal\ 里拿出来，靠的是 agent/lib/paths.js 这一处路径真源：
# 它按"agent 是不是装在 internal\ 下"判断包根在哪，进而定位包根下的 data\。
$internal = Join-Path $StageDir 'internal'
New-Item -ItemType Directory -Path $internal -Force | Out-Null

# ── 2b. 数据目录与内置数据目录（2026-10 目录重构）────────────────────
# 新布局（依据 agent/lib/paths.js）：
#   <包根>\data\      用户数据，按类型分格。**备份 = 复制这一个文件夹。**
#   <包根>\builtin\   随包分发的内置数据（图谱回退源、演示图）。不属于用户，不参与备份。
#   <包根>\logs\      日志（托盘输出、侧栏调试上报）。可随时清空。
# 为什么数据放在包根、不再藏在 internal\ 里：internal\ 的定位是"程序，用户别动"
# （README-FIRST.txt 原话），数据关在里面就违背这个定位。旧布局的实际代价见
# distribution-design.md 的记录与 agent/lib/paths.js 头部注释。
$dataRoot = Join-Path $StageDir 'data'
$builtinRoot = Join-Path $StageDir 'builtin'
$logsRoot = Join-Path $StageDir 'logs'
# 各格都建出来（空目录随包分发）：用户第一次打开就能看懂数据分了几类，
# 而不是等程序自己按需创建、看起来像"哪一格是空的出问题了"。
foreach ($d in @('config', 'profile', 'sessions', 'reading', 'runtime', 'toolbox')) {
  New-Item -ItemType Directory -Path (Join-Path $dataRoot $d) -Force | Out-Null
}
New-Item -ItemType Directory -Path $builtinRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
# data\ 的中文说明书（源文件在 installer\portable\DATA-README.txt，纯 ASCII 文件名 + UTF-8 内容）
Copy-Item (Join-Path $PSScriptRoot 'portable\DATA-README.txt') (Join-Path $dataRoot 'README.txt')

# ── 3. Node 运行时（只带 node.exe）──────────────────────────────────
Write-Host '--- Node 运行时 ---'
# 三种取 Node 的方式，优先级从高到低：
#   1) -NodeDir       指定一个已含 node.exe 的目录（CI 里指向 runner 自带的 Node，最快且不联网）
#   2) 本地缓存         %TEMP%\node-official\node-<版本>-win-x64（上次下载解压留下的）
#   3) 下载官方 zip    可用环境变量 COREAD_NODE_MIRROR 换镜像前缀
#                      （官方站在 GitHub 上，国内偶尔慢；换镜像时设成如
#                       https://registry.npmmirror.com/-/binary/node 即可）
$nodeSrc = $NodeDir
if (-not $nodeSrc) {
  $nodeSrc = Join-Path $env:TEMP ("node-official\node-{0}-win-x64" -f $NodeVersion)
  if (-not (Test-Path (Join-Path $nodeSrc 'node.exe'))) {
    $mirror = $env:COREAD_NODE_MIRROR
    if ($mirror) {
      $url = ($mirror.TrimEnd('/')) + "/$NodeVersion/node-$NodeVersion-win-x64.zip"
    } else {
      $url = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
    }
    $zipFile = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    Write-Step "下载 Node：$url"
    if (-not (Test-Path $zipFile)) {
      node -e "const fs=require('fs');fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const f=fs.createWriteStream(process.argv[2]);for await(const c of r.body)f.write(c);await new Promise(x=>f.end(x))}).catch(e=>{console.error(e.message);process.exit(1)})" $url $zipFile
      if ($LASTEXITCODE -ne 0) {
        Fail "Node 下载失败。三个办法：`n  1) 用 -NodeDir 指定一个已含 node.exe 的目录（CI 推荐）`n  2) 设环境变量 COREAD_NODE_MIRROR 指向镜像（如 https://registry.npmmirror.com/-/binary/node）`n  3) 手动下载解压到 $nodeSrc"
      }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $exDir = Join-Path $env:TEMP 'node-official'
    New-Item -ItemType Directory -Path $exDir -Force | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipFile, $exDir)
  }
}
Copy-Item (Join-Path $nodeSrc 'node.exe') $internal
# Node 自己的许可证：随包分发要带上（Apache-2.0 等要求保留声明）。
# 官方 zip 里有 LICENSE；而 CI 里 runner 自带的 Node 目录通常没有，
# 所以仓库里存了一份兜底（installer\launcher\LICENSE.node.txt）。
$lic = Join-Path $nodeSrc 'LICENSE'
if (Test-Path $lic) {
  Copy-Item $lic (Join-Path $internal 'LICENSE.node.txt')
} else {
  $repoLic = Join-Path $PSScriptRoot 'launcher\LICENSE.node.txt'
  if (Test-Path $repoLic) { Copy-Item $repoLic (Join-Path $internal 'LICENSE.node.txt') }
  else { Write-Host '  [警告] 没有 Node 的 LICENSE 文件，随包分发前请补上' -ForegroundColor Yellow }
}
Write-Step ("node.exe  " + [math]::Round((Get-Item (Join-Path $nodeSrc 'node.exe')).Length / 1MB, 1) + ' MB')

# ── 4. 程序文件（白名单，绝不整目录拷）──────────────────────────────
Write-Host "`n--- 程序文件 ---"
$agentOut = Join-Path $internal 'agent'
New-Item -ItemType Directory -Path $agentOut -Force | Out-Null
Copy-Item (Join-Path $repo 'agent\index.js')     $agentOut
Copy-Item (Join-Path $repo 'agent\package.json') $agentOut
Copy-Item (Join-Path $repo 'agent\lib')          $agentOut -Recurse
if (Test-Path (Join-Path $repo 'agent\.env.example')) { Copy-Item (Join-Path $repo 'agent\.env.example') $agentOut }

# 随包分发的"内置数据"产物 → <包根>\builtin\（2026-10 前放在 internal\agent\scripts\data\）
#
# ⚠️ 这里曾经踩过一个**方向搞反**的坑，记录一下免得重犯：
#   白名单里原本还写了 knowledge-graph-results.json 和 knowledge-graph-demo.json，
#   而 agent/scripts/data/ 整个目录是被 .gitignore 排除的。
#   后果是：本地打包时文件在，就被拷进包（CI 上不存在，静默跳过），
#   于是"本地包"比"release 包"多出 2 个文件 —— 而那 2 个文件里装的是
#   **作者自己的读书会意图谱**（读《静静的顿河》积累的 55 个节点/27 条边）。
#   也就是说，本地打包会把个人阅读数据一起发出去，而 CI 打包反而躲过了。
#   现在规则说清楚：author 私人的"读数产物"（judge-*、knowledge-graph-results 的真实版）
#   一律不进包；真正要随包分发的只有下面这两个**通用**文件。
$shipped = @('knowledge-graph-results.json', 'knowledge-graph-demo.json')
foreach ($f in $shipped) {
  $p = Join-Path $repo "agent\scripts\data\$f"
  if (Test-Path $p) { Copy-Item $p $builtinRoot; Write-Step "builtin\$f" }
  else { Write-Step "（跳过缺失的 $f —— 它没提交进 git，CI 上也不会有）" }
}
# 两个冒烟用例（开发期用，体积小且不含个人数据）：仍随包，放 internal\agent\scripts\data
$dataOut = Join-Path $agentOut 'scripts\data'
New-Item -ItemType Directory -Path $dataOut -Force | Out-Null
foreach ($f in @('smoke-stack-sequences.json', 'judge-smoke-cases.json')) {
  $p = Join-Path $repo "agent\scripts\data\$f"
  if (Test-Path $p) { Copy-Item $p $dataOut }
  else { Write-Step "（跳过缺失的 $f —— 它没提交进 git，CI 上也不会有）" }
}

# ── 面向用户的维护脚本（2026-10 加入）────────────────────────────────
# 为什么必须进包：说明书明确让用户跑数据迁移（从旧版本升上来的记录还在旧位置），
# 而在此之前整个 agent\scripts\ 目录都不在白名单里 —— 用户照说明抄的命令必然失败：
#   ① 脚本不在包里（Cannot find module）
#   ② node 不在 PATH（自带的是 internal\node.exe）
# 只带这三个，因为它们都直接服务于用户会遇到的事：
#   migrate-data-layout.mjs  老版本数据搬家（说明书里点名的那条命令）
#   backup-chat.mjs          把聊天库安全备份一份（chat.db 有 -wal，不能只拷主库）
#   chat.db.diag-wal.mjs     诊断"主库与暂存本谁新"，备份可疑时先跑它
# ⚠️ 只能逐个点名，**绝不能整目录拷**：同目录下的 data\ 与 _l3_sample.txt 里是
#    作者自己的真实语料（2026-10 的教训：本地打包会把它带出去，CI 反而躲过了）。
$userScripts = @('migrate-data-layout.mjs', 'backup-chat.mjs', 'chat.db.diag-wal.mjs')
$scriptsOut = Join-Path $agentOut 'scripts'
New-Item -ItemType Directory -Path $scriptsOut -Force | Out-Null
foreach ($f in $userScripts) {
  $p = Join-Path $repo "agent\scripts\$f"
  if (-not (Test-Path $p)) { Fail "缺少 agent\scripts\$f —— 说明书写着让用户跑它，不能少" }
  Copy-Item $p $scriptsOut
  Write-Step "internal\agent\scripts\$f"
}

# receiver 的程序文件放 internal\receiver（与 agent 同级：lib/paths.js 靠这个同级关系定位包根）
$recvOut = Join-Path $internal 'receiver'
New-Item -ItemType Directory -Path $recvOut -Force | Out-Null
foreach ($f in @('index.js', 'package.json', 'graph-data.js')) {
  $p = Join-Path $repo "receiver\$f"
  if (Test-Path $p) { Copy-Item $p $recvOut }
}

# extension 放在最外层显眼位置。
# 为什么放外面而不是 internal\：这是用户在装插件时**必须去选中的目录**，
# 藏进"不要动"的文件夹里说不通。它本身也是纯前端资源，没有可动的风险。
Copy-Item (Join-Path $repo 'extension') $StageDir -Recurse
Remove-Item (Join-Path $StageDir 'extension\test') -Recurse -Force -EA SilentlyContinue

# 图标：托盘用的 coread.ico 放包根 assets\icons\（托盘就按这个相对路径找它）；
# 浏览器插件图标在 extension\icons\ 里，随 extension 一起走。
# 生成脚本 tools\make-icons.ps1；缺了它托盘会退回系统默认图标，不会报错。
$assetsSrc = Join-Path $repo 'assets\icons'
if (-not (Test-Path (Join-Path $assetsSrc 'coread.ico'))) {
  Fail '缺少 assets\icons\coread.ico —— 先跑 tools\make-icons.ps1'
}
New-Item -ItemType Directory -Path (Join-Path $StageDir 'assets\icons') -Force | Out-Null
Copy-Item (Join-Path $assetsSrc 'coread.ico') (Join-Path $StageDir 'assets\icons')
Write-Step 'assets\icons\coread.ico'

# ⚠️ 这里**故意不放** data\config\api-config.json（2026-10 改）。
# 以前会拷一份 launcher\api-config.template.json 的空模板进去，理由是"程序起不来就没法
# 让用户填 Key"。但它是**用户数据**：用户升级时最自然的做法就是把新 zip 解压到旧文件夹上
# 覆盖，那样一覆盖，他填好的 API 地址/密钥/模型名就被这个空模板**清空**了 ——
# 而 files（升级只覆盖程序文件、data\ 归用户）本来是打包脚本自己定的规矩。
# 去掉它的安全性已核实（agent\lib\api-config.js）：
#   · readApiConfigFile() 打不开文件就返回 {}，不会报错；
#   · writeApiConfig() 会先 mkdirSync 再写，用户第一次在侧栏保存时自动创建；
#   · 缺失时 resolveApiConfig() 照常回退到 data\config\env 与默认模型。
# 于是"解压新包覆盖旧文件夹"变成**安全且正确**的升级方式，不再需要额外说明。
# 结果是 data\config\ 变成空目录 —— 空目录在 zip 里有条目，所以校验清单里写
# 'data\config\' 而不是具体文件名（见文件末尾的 $need）。
Write-Step 'data\config\（空目录，不随包分发任何配置文件）'

# ── 5. 启动器与说明文件 ─────────────────────────────────────────────
Write-Host "`n--- 启动器与说明 ---"
# 全部放 internal，它们是内部实现。其中 Start-CoRead.vbs 是**唯一入口**：
# 用户双击它启动。为什么不是 .bat 见该文件头部注释（.bat 必被 cmd.exe 拉出黑框；
# .vbs 由 GUI 的 wscript.exe 执行，一点窗口都不出现）。
foreach ($f in @('tray.ps1', 'stop.bat')) {
  $p = Join-Path $PSScriptRoot "launcher\$f"
  if (-not (Test-Path $p)) { Fail "缺少 launcher\$f" }
  Copy-Item $p $internal
  Write-Step "internal\$f"
}
$starter = Join-Path $PSScriptRoot 'portable\Start-CoRead.vbs'
if (-not (Test-Path $starter)) { Fail '缺少 portable\Start-CoRead.vbs' }
Copy-Item $starter $internal
Write-Step 'internal\Start-CoRead.vbs'
foreach ($f in @('unblock.bat', 'instructions-zh.txt')) {
  $p = Join-Path $PSScriptRoot "portable\$f"
  if (Test-Path $p) { Copy-Item $p $internal; Write-Step "internal\$f" }
  else { Fail "缺少 portable\$f" }
}
# 外层一页纸说明（详细手册在 internal\instructions-zh.txt）
Copy-Item (Join-Path $PSScriptRoot 'portable\README-FIRST.txt') $StageDir
Write-Step 'README-FIRST.txt'

# ── 6. 给文件夹加"中文显示名" ───────────────────────────────────────
# 做法：desktop.ini + LocalizedResourceName / LocalizedFileNames，只改**显示名**，
#       磁盘上的真实文件夹名（data、internal）不动——代码里的路径是写死的。
# 生效条件（都实测过）：
#   · desktop.ini 必须是 UTF-16LE（带 FF FE BOM）
#   · 所在文件夹要带 ReadOnly 或 System 属性
#   · desktop.ini 自身要 Hidden + System
#   · 只影响它所在的那一层，不会递归到子文件夹
#
# ⚠️ 重要限制（实测确认）：**zip 解压会丢掉文件夹属性**。
#    资源管理器的"全部解压缩"、PowerShell 的 Expand-Archive、Shell COM 的
#    CopyHere —— 三种方式都试过，解压后属性一律变成普通 Directory，
#    于是 desktop.ini 不被读取、中文显示名不生效。
#    所以下面这些标签**当前对 zip 分发没有实际效果**，保留它们的目的是：
#      · 换成自解压包（可带"解压后执行"脚本补属性）时可直接生效
#      · 直接拷目录分发（U 盘、网盘同步）时生效
#    走 zip 时它们无害（只是不生效），不会影响任何功能。
if (-not $WriteFolderLabels) {
  Write-Host "`n--- 文件夹显示名：已跳过 ---"
  Write-Host "  原因：zip 解压会丢掉文件夹属性，desktop.ini 不会被读取，显示名不生效，"
  Write-Host "  而且属性丢失后这些 desktop.ini 会变成可见文件、给用户添乱。"
  Write-Host "  想启用请加 -WriteFolderLabels（仅对自解压包等能补属性的分发方式有意义）。"
} else {
Write-Host "`n--- 文件夹显示名 ---"
$labels = @(
  @{ dir = $dataRoot;                       name = '你的数据（备份就复制这个文件夹）';        tip = 'CoRead 的全部个人数据：配置、画像、聊天记录、书与标注、翻译记录。删掉等于清空所有记录。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'config');  name = '设置（含密钥，别外发）';                  tip = '模型 API 地址与密钥。把数据发给别人排查问题前，先删掉这一格。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'profile'); name = '画像与知识图谱';                          tip = 'AI 对你的长期理解：阅读画像、价值观侧写、会意图谱。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'sessions'); name = '聊天记录与讨论';                          tip = '聊天库、会话流水账、正在进行的讨论栈。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'reading'); name = '书与标注';                                tip = '划线标注、书库缓存（读过的章节原文）。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'runtime'); name = '运行状态（可删）';                        tip = '处理进度之类的临时状态。删掉只会让程序重新扫一遍，不丢记录。'; files = $null }
  @{ dir = (Join-Path $dataRoot 'toolbox'); name = '翻译记录';                                tip = '工具箱的翻译历史。'; files = $null }
  @{ dir = $internal;                       name = '程序文件（不要动）';                      tip = '程序自己用的文件：运行环境、代码、说明书。正常使用不需要打开这里。'; files = $null }
  @{ dir = (Join-Path $StageDir 'extension'); name = '浏览器插件（装插件时选这个）';             tip = '在浏览器扩展页点「加载已解压的扩展程序」后，选中这个目录。'; files = $null }
  # 外层：文件夹本身不改名（保持解压出来的样子），但把说明文件显示成中文
  @{ dir = $StageDir; name = $null; tip = $null; files = @{ 'README-FIRST.txt' = '先看我，一分钟'; 'README-FIRST' = '先看我，一分钟' } }
)
function Set-FolderLabel($dir, $displayName, $tipText, $fileNames) {
  if (-not (Test-Path $dir)) { return $false }
  $iniPath = Join-Path $dir 'desktop.ini'
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('[.ShellClassInfo]')
  if ($displayName) { [void]$sb.AppendLine("LocalizedResourceName=$displayName") }
  if ($tipText)     { [void]$sb.AppendLine("InfoTip=$tipText") }
  if ($fileNames) {
    # 改"文件名"要用另一节。实测有效（`@文件名` 那种引用 DLL 资源的写法无效）。
    [void]$sb.AppendLine('[LocalizedFileNames]')
    foreach ($k in $fileNames.Keys) { [void]$sb.AppendLine("$k=$($fileNames[$k])") }
  }
  [System.IO.File]::WriteAllText($iniPath, $sb.ToString(), [System.Text.Encoding]::Unicode)
  & attrib.exe +h +s $iniPath | Out-Null
  & attrib.exe +r +s $dir      | Out-Null     # +s 让外层文件夹也带上 System 属性
  return $true
}
foreach ($l in $labels) {
  if (Set-FolderLabel $l.dir $l.name $l.tip $l.files) {
    $rel = ($l.dir -replace [regex]::Escape($StageDir + '\'), '')
    if (-not $rel) { $rel = '(包根)' }
    $shown = if ($l.name) { $l.name } else { ($l.files.Values | Select-Object -First 1) }
    Write-Step ("{0}  →  「{1}」" -f $rel, $shown)
  }
}
}   # end if (-not $WriteFolderLabels)

# 检查所有脚本类文件的编码兼容性。两条规则都是实测踩坑换来的：
#
#  .bat（cmd.exe 按系统 ANSI 代码页读取，中文 Windows 是 GBK）
#     → 执行部分必须纯 ASCII。UTF-8 中文会变乱码；而且 cmd 是边读边执行，
#       文中途 chcp 65001 会让解析错位，乱码碎片被当成命令执行，
#       报一堆"不是内部或外部命令"。
#  .vbs（Windows Script Host 同样按系统 ANSI 读取）
#     → 必须纯 ASCII。UTF-8 中文会破坏字符串字面量，直接编译失败
#       （"Microsoft VBScript 编译器错误: 语句未结束"）。
#  .ps1（Windows PowerShell 5.1 按 ANSI 读取无 BOM 的 UTF-8）
#     → 必须带 UTF-8 BOM，下面单独处理。
#
# 中文面向用户的内容统一放 instructions-zh.txt，那些脚本文件只留英文。
$scriptProblems = @()
foreach ($f in (Get-ChildItem $StageDir -Recurse -File -Include '*.bat', '*.vbs' -EA SilentlyContinue)) {
  $isBat = $f.Extension -eq '.bat'
  $lines = [System.IO.File]::ReadAllLines($f.FullName, [System.Text.Encoding]::UTF8)
  foreach ($l in $lines) {
    # 跳过注释行
    if ($isBat -and ($l -match '^\s*rem\b' -or $l -match '^\s*::')) { continue }
    if (-not $isBat -and $l -match "^\s*'") { continue }
    if ($l -match '[^\x00-\x7F]') { $scriptProblems += "$($f.Name) [非ASCII]: $l" }
    if ($isBat -and $l -match 'chcp\s+65001') { $scriptProblems += "$($f.Name) [chcp65001]: $l" }
  }
}
if ($scriptProblems.Count) {
  Write-Host '❌ 脚本文件的执行部分含非 ASCII 或 chcp 65001，会在中文 Windows 上报错：' -ForegroundColor Red
  $scriptProblems | Select-Object -First 10 | ForEach-Object { Write-Host "   $_" }
  Write-Host '   （中文说明请放到 instructions-zh.txt）' -ForegroundColor Red
  exit 1
}
Write-Step '✅ .bat / .vbs 执行部分为纯 ASCII（cmd 与 WSH 兼容）'

# 保证 .ps1 带 UTF-8 BOM（PowerShell 5.1 必需，否则中文乱码且语法崩）
foreach ($ps1 in Get-ChildItem $StageDir -Recurse -File -Filter '*.ps1' -EA SilentlyContinue) {
  $bytes = [System.IO.File]::ReadAllBytes($ps1.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if (-not $hasBom) {
    [System.IO.File]::WriteAllBytes($ps1.FullName, ([byte[]](0xEF, 0xBB, 0xBF) + $bytes))
    Write-Step "为 $($ps1.Name) 补 UTF-8 BOM"
  }
}

# ── 7. 敏感数据闸门 ─────────────────────────────────────────────────
Write-Host "`n--- 敏感数据检查 ---"
$bad = @()
foreach ($pat in @('*.db', '*.db-wal', '*.db-shm', '*.jsonl', 'topic_stack.json', 'hist_cursors.json', '*.bak', '*.out', 'profile.md', 'soul.md')) {
  Get-ChildItem $StageDir -Recurse -File -Force -Filter $pat -EA SilentlyContinue | ForEach-Object { $bad += $_.FullName }
}
Get-ChildItem $StageDir -Recurse -File -Force -Filter '*.env' -EA SilentlyContinue |
  Where-Object { $_.Name -ne '.env.example' } | ForEach-Object { $bad += $_.FullName }
# 数据目录必须**只有空壳**。data\ 是用户的地盘，而升级时用户最自然的做法就是把新 zip
# 解压到旧文件夹上覆盖 —— 所以包里多带任何一个数据文件，都会在升级那一刻盖掉他自己的东西。
# 2026-10 就是这么出事的：包里带了 config\api-config.json 的空模板，一覆盖就把用户填好的
# API 地址/密钥/模型名清空（而"升级只覆盖程序文件、data\ 归用户"本来是打包脚本自己定的规矩）。
# 现在这里**没有任何例外**：data\ 各格除 desktop.ini 与 README.txt（我们放的说明）之外，
# 出现任何文件都直接中止打包。比原来更严 —— 宁可打包失败，也不让用户的数据被覆盖。
foreach ($d in @('data\config', 'data\profile', 'data\sessions', 'data\reading', 'data\runtime', 'data\toolbox')) {
  $full = Join-Path $StageDir $d
  if (Test-Path $full) {
    Get-ChildItem $full -Recurse -File -Force -EA SilentlyContinue |
      Where-Object { $_.Name -ne 'desktop.ini' -and $_.Name -ne 'README.txt' } |
      ForEach-Object { $bad += "$($_.FullName) （data\ 下只允许空目录与说明文件）" }
  }
}
# builtin\ 允许清单：只有这两个**通用**图谱文件（随包分发，agent 与 receiver 运行时读它们）
# 其余任何文件都不许进——这一格最容易被人手滑塞进"作者自己的图谱产物"。
$builtinAllow = @('knowledge-graph-results.json', 'knowledge-graph-demo.json')
$builtinFull = Join-Path $StageDir 'builtin'
if (Test-Path $builtinFull) {
  Get-ChildItem $builtinFull -Recurse -File -Force -EA SilentlyContinue |
    Where-Object { $builtinAllow -notcontains $_.Name } |
    ForEach-Object { $bad += "$($_.FullName) （builtin 里只允许通用图谱文件）" }
  # 并且必须与仓库里的源文件逐字节一致——防止"本地打包带出个人变体、CI 打包没有"那种
  # 两边不一致、极难察觉的情况（这正是当初 knowledge-graph-results.json 踩过的坑）。
  foreach ($n in $builtinAllow) {
    $staged = Join-Path $builtinFull $n
    $source = Join-Path $repo "agent\scripts\data\$n"
    if (-not (Test-Path $staged)) { continue }
    if (-not (Test-Path $source)) { $bad += "$staged （仓库里找不到源文件，无法核对）"; continue }
    $h1 = (Get-FileHash $staged -Algorithm SHA256).Hash
    $h2 = (Get-FileHash $source -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { $bad += "$staged （与仓库源文件不一致，可能是个人数据变体）" }
  }
}

# 按**文件名**再挡一道：这些是"真实阅读数据"性质的产物。
# 为什么按名字挡而不是靠扩展名：它们是 .json，跟随包分发的正常产物没法区分。
# 为什么需要这道锁：它们被 .gitignore 排除，本地存在、CI 不存在——
# 一旦有人（包括未来的我）手滑把它们加回白名单，本地打包就会把作者的
# 读书笔记发出去，而 CI 打包看不出来，两边行为不一致、极难察觉。
# 例外：knowledge-graph-{results,demo}.json 在 builtin\ 下是**合法**的（上面已单独校验
# 它们与仓库源文件一致），所以这两个名字在全盘扫描时放行；它们出现在别处仍然会被抓。
$nameAllowInBuiltin = @('knowledge-graph-results.json', 'knowledge-graph-demo.json')
foreach ($name in @('knowledge-graph-results.json', 'knowledge-graph-demo.json',
                    'judge-real-cases.json', 'judge-real-results.json',
                    'derive-knowledge-graph-inject.json')) {
  Get-ChildItem $StageDir -Recurse -File -Force -Filter $name -EA SilentlyContinue |
    Where-Object {
      -not ($nameAllowInBuiltin -contains $_.Name -and $_.DirectoryName -eq $builtinFull)
    } |
    ForEach-Object { $bad += "$($_.FullName) （真实阅读数据，不应随包分发）" }
}

if ($bad.Count) {
  Write-Host '❌ 发现不该打包的内容，已中止：' -ForegroundColor Red
  $bad | Select-Object -First 15 | ForEach-Object { Write-Host "   $_" }
  exit 1
}
Write-Step '✅ 无个人数据、无密钥、无备份残留'

# ── 6. 压成 zip（用 .NET，确保条目路径是正斜杠）──────────────────────
Write-Host "`n--- 压缩 ---"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$zipPath = Join-Path $OutDir "CoRead-$ver-portable.zip"
Remove-Item $zipPath -Force -EA SilentlyContinue

Add-Type -AssemblyName System.IO.Compression.FileSystem
# 用 ZipFile.CreateFromDirectory，它会写正斜杠；中文文件名在 UTF-8 条目名里也正常
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $StageDir, $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false)          # includeBaseDirectory=false：解压出来直接是文件，不套一层

$rawSize = (Get-ChildItem $StageDir -Recurse -File | Measure-Object Length -Sum).Sum
$zipSize = (Get-Item $zipPath).Length
Write-Step ("解压后 " + [math]::Round($rawSize / 1MB, 1) + " MB  →  zip " + [math]::Round($zipSize / 1MB, 1) + " MB")

# 校验 zip 内容
#
# ⚠️ 这里有个跨 PowerShell 版本的坑，CI 上踩过一次：
#   $_.FullName 返回的分隔符方向**随 PS 版本而变**。
#   同一个 zip，用 PowerShell 5.1（本地）读出来是 'internal/node.exe'，
#   用 PowerShell 7（GitHub Actions 用的）读出来是 'internal\node.exe'。
#   而下面 $need 清单里写的是 Windows 反斜杠，于是 5.1 下全对、7 下全 MISS，
#   报"zip 里缺 13 个关键文件"——实际包是好的，只是字符串没对上。
#   修法：比较前把两边都归一化成反斜杠，与 PS 版本无关。
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$names = $zip.Entries | ForEach-Object { $_.FullName.Replace('/', '\') }
Write-Host "`n--- zip 校验 ---"
$need = @(
  # 用户直接面对的（入口现在是 .vbs，在 internal 下；包根只有说明文件）
  'README-FIRST.txt',
  # internal 里的程序与说明
  'internal\node.exe',
  'internal\Start-CoRead.vbs',
  'internal\tray.ps1',
  'internal\stop.bat',
  'internal\unblock.bat',
  'internal\instructions-zh.txt',
  'internal\agent\index.js',
  'internal\agent\lib\paths.js',
  # 面向用户的维护脚本：说明书写着让用户跑迁移，缺一个用户就卡死在那一步。
  # 写进校验清单是为了让"脚本没进包"这种静默缺失在打包时就炸出来，而不是等用户撞上。
  'internal\agent\scripts\migrate-data-layout.mjs',
  'internal\agent\scripts\backup-chat.mjs',
  'internal\agent\scripts\chat.db.diag-wal.mjs',
  'internal\receiver\index.js',
  # 数据目录（程序运行时往这里写；空壳随包分发，2026-10 重构后数据在包根 data\）
  # 注意：**只有空目录才会在 zip 里有条目**。有内容的目录（data\config、builtin）
  # 不会单独出现，要校验就直接写里面的文件名——写成 'data\config\' 会假报 MISS（实测踩过）。
  'data\README.txt',
  # data\config\ 现在是**空目录**（包里不再带 api-config.json，见第 3 步的注释）——
  # 只有空目录才会在 zip 里有条目，所以要写成目录名本身。
  'data\config\',
  'data\profile\',
  'data\sessions\',
  'data\reading\',
  'data\runtime\',
  'data\toolbox\',
  # 内置数据（随包分发的图谱回退源与演示图）
  'builtin\knowledge-graph-results.json',
  'builtin\knowledge-graph-demo.json',
  # 图标（托盘用）
  'assets\icons\coread.ico',
  # 插件图标
  'extension\icons\icon128.png'
)
$missing = 0
foreach ($n in $need) {
  if ($names -contains $n) { Write-Step "OK   $n" } else { Write-Step "MISS $n"; $missing++ }
}
$zipCount = $zip.Entries.Count      # 必须**先**取，下面 Dispose 之后 Entries 就空了
$zip.Dispose()
if ($missing) { Fail "zip 里缺 $missing 个关键文件" }

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host ("  " + $zipCount + " 个条目" )
