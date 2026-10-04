# 生成免安装的便携包（zip）
#
# 与 pack-portable.ps1 的区别：那个产出给 Inno 安装程序用的暂存目录（会写 %TEMP%、
# 会写注册表，因而会触发火绒 HIPS）；这个产出一个"解压即用"的 zip——
# 用户自己解压，程序不碰 %TEMP%、不写注册表，被安全软件拦的概率低得多。
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
# 最外层只留三样：
#     extension\       ← 浏览器插件（装插件时必须选它）
#     internal\        ← 程序 + 数据，都在这里
#     几个 .bat / 说明  ← 双击启动、出问题看说明
# 注意：**没有单独的 data\ 目录**。数据目录是代码里写死的、跟着代码走，
# 所以它在 internal\agent\data 与 internal\receiver\ 下（详见下方说明）。
# 不去硬造一个"看起来像数据目录"的空壳——那会让用户以为数据在那、实际不在。
$internal = Join-Path $StageDir 'internal'
New-Item -ItemType Directory -Path $internal -Force | Out-Null

# ── 3. Node 运行时（只带 node.exe）──────────────────────────────────
Write-Host '--- Node 运行时 ---'
$nodeSrc = $NodeDir
if (-not $nodeSrc) {
  $nodeSrc = Join-Path $env:TEMP ("node-official\node-{0}-win-x64" -f $NodeVersion)
  if (-not (Test-Path (Join-Path $nodeSrc 'node.exe'))) {
    Fail "找不到已解压的官方 Node：$nodeSrc`n  请先跑一次 installer\pack-portable.ps1（它会下载并解压），或用 -NodeDir 指定。"
  }
}
Copy-Item (Join-Path $nodeSrc 'node.exe') $internal
$lic = Join-Path $nodeSrc 'LICENSE'
if (Test-Path $lic) { Copy-Item $lic (Join-Path $internal 'LICENSE.node.txt') }
Write-Step ("node.exe  " + [math]::Round((Get-Item (Join-Path $nodeSrc 'node.exe')).Length / 1MB, 1) + ' MB')

# ── 4. 程序文件（白名单，绝不整目录拷）──────────────────────────────
Write-Host "`n--- 程序文件 ---"
$agentOut = Join-Path $internal 'agent'
New-Item -ItemType Directory -Path $agentOut -Force | Out-Null
Copy-Item (Join-Path $repo 'agent\index.js')     $agentOut
Copy-Item (Join-Path $repo 'agent\package.json') $agentOut
Copy-Item (Join-Path $repo 'agent\lib')          $agentOut -Recurse
if (Test-Path (Join-Path $repo 'agent\.env.example')) { Copy-Item (Join-Path $repo 'agent\.env.example') $agentOut }
$dataOut = Join-Path $agentOut 'scripts\data'
New-Item -ItemType Directory -Path $dataOut -Force | Out-Null
foreach ($f in @('knowledge-graph-results.json', 'knowledge-graph-demo.json', 'smoke-stack-sequences.json', 'judge-smoke-cases.json')) {
  $p = Join-Path $repo "agent\scripts\data\$f"
  if (Test-Path $p) { Copy-Item $p $dataOut }
}
New-Item -ItemType Directory -Path (Join-Path $agentOut 'data') -Force | Out-Null

# receiver 的程序文件放 internal\receiver
$recvOut = Join-Path $internal 'receiver'
New-Item -ItemType Directory -Path $recvOut -Force | Out-Null
foreach ($f in @('index.js', 'package.json', 'graph-data.js')) {
  $p = Join-Path $repo "receiver\$f"
  if (Test-Path $p) { Copy-Item $p $recvOut }
}

# ── 用户数据目录 ────────────────────────────────────────────────────
# 真相：数据目录是**代码里写死的**，位置跟着代码走：
#     agent/index.js    → AGENT_DIR 自己，以及 <AGENT_DIR>/data/knowledge-graph.json
#     receiver/index.js → <自身>/inbox、<自身>/books、<自身>/toolbox
# 而 agent 与 receiver 必须保持同级（agent 用 ../receiver 找 inbox），
# 所以两个都放 internal\ 之后，数据就落在：
#     internal\agent\data\          阅读画像、知识图谱、讨论栈、API 配置
#     internal\receiver\inbox\      聊天记录、标注
#     internal\receiver\books\      书库缓存
#     internal\receiver\toolbox\    翻译记录
#
# 曾经试过把数据挪到根目录一个显眼的 data\：需要给代码加环境变量、改 16 处
# 路径，风险大收益小；用目录联接（junction）试过又会让"备份只拷 data\"落空。
# 最后选择**如实呈现**：数据就在 internal\ 里，说明书直接写明位置，
# 备份方式改成"拷整个程序文件夹"。这样不多一层抽象，用户也不会误判。
$dataRecv = Join-Path $recvOut ''          # internal\receiver
$dataAgent = Join-Path $agentOut ''        # internal\agent
New-Item -ItemType Directory -Path (Join-Path $dataAgent 'data') -Force | Out-Null
foreach ($d in @('inbox', 'books', 'toolbox')) {
  New-Item -ItemType Directory -Path (Join-Path $dataRecv $d) -Force | Out-Null
}

# extension 放在最外层显眼位置。
# 为什么放外面而不是 internal\：这是用户在装插件时**必须去选中的目录**，
# 藏进"不要动"的文件夹里说不通。它本身也是纯前端资源，没有可动的风险。
Copy-Item (Join-Path $repo 'extension') $StageDir -Recurse
Remove-Item (Join-Path $StageDir 'extension\test') -Recurse -Force -EA SilentlyContinue

# API 配置模板（空值）
Copy-Item (Join-Path $PSScriptRoot 'launcher\api-config.template.json') (Join-Path $agentOut 'api-config.json')

# ── 5. 启动器与说明文件 ─────────────────────────────────────────────
Write-Host "`n--- 启动器与说明 ---"
# 启动器（tray/vbs/stop）放 internal，它们是内部实现
foreach ($f in @('tray.ps1', 'run-hidden.vbs', 'stop.bat')) {
  $p = Join-Path $PSScriptRoot "launcher\$f"
  if (-not (Test-Path $p)) { Fail "缺少 launcher\$f" }
  Copy-Item $p $internal
  Write-Step "internal\$f"
}
# 用户直接面对的入口放最外层；说明书与解除工具放 internal（说明里会指路）
Copy-Item (Join-Path $PSScriptRoot 'portable\01-START-CoRead.bat') $StageDir
Write-Step '01-START-CoRead.bat'
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
  @{ dir = (Join-Path $agentOut 'data');    name = '你的数据（阅读记录、画像、聊天都在这里）'; tip = 'CoRead 的全部个人数据。想备份就复制整个程序文件夹；删掉这个文件夹等于清空所有记录。'; files = $null }
  @{ dir = (Join-Path $recvOut 'inbox');    name = '聊天与标注';                              tip = '聊天记录、收到的划线标注。'; files = $null }
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
$cfg = Join-Path $agentOut 'api-config.json'
if ((Test-Path $cfg) -and ((Get-Content $cfg -Raw) -match 'sk-[A-Za-z0-9]{10}')) { $bad += $cfg }
# 数据目录必须是空的（只有我们自己放的 desktop.ini）
foreach ($d in @('data\agent', 'data\receiver\inbox', 'data\receiver\books', 'data\receiver\toolbox')) {
  $full = Join-Path $StageDir $d
  if (Test-Path $full) {
    Get-ChildItem $full -Recurse -File -Force -EA SilentlyContinue |
      Where-Object { $_.Name -ne 'desktop.ini' } |
      ForEach-Object { $bad += "$($_.FullName) （数据目录应只有 desktop.ini）" }
  }
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
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$names = $zip.Entries | ForEach-Object { $_.FullName }
Write-Host "`n--- zip 校验 ---"
$need = @(
  # 用户直接面对的
  '01-START-CoRead.bat',
  # internal 里的程序与说明
  'internal\node.exe',
  'internal\tray.ps1',
  'internal\run-hidden.vbs',
  'internal\stop.bat',
  'internal\unblock.bat',
  'internal\instructions-zh.txt',
  'internal\agent\index.js',
  'internal\agent\api-config.json',
  'internal\receiver\index.js',
  # 数据目录（程序运行时往这里写；空壳随包分发）
  'internal\agent\data\',
  'internal\receiver\inbox\',
  'internal\receiver\books\',
  'internal\receiver\toolbox\'
)
$missing = 0
foreach ($n in $need) {
  if ($names -contains $n) { Write-Step "OK   $n" } else { Write-Step "MISS $n"; $missing++ }
}
$zip.Dispose()
if ($missing) { Fail "zip 里缺 $missing 个关键文件" }

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host ("  " + $zip.Entries.Count + " 个条目" )
