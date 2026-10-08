# CoRead 升级脚本（2026-11）
#
# 干什么：把新版本的便携包（zip）装到当前这个程序目录上，并**清掉旧版本留下的文件**。
#
# 为什么需要它：在这之前，升级的唯一做法是"把新 zip 解压覆盖到旧文件夹上"。覆盖有两个
# 治不好的毛病 —— ① 新版本删掉的文件会永远留着；② 新版本不再用的文件（比如 builtin\
# 里的旧回退图谱）**代码可能还在读它**，于是同一个版本号在不同人的机器上表现不一样。
# 谁调用它：包根的 Update-CoRead.cmd（双击，或把 zip 拖到它上面）。那个 .cmd 会先把
# 自己与本脚本复制到 %TEMP% 再启动 —— 因为本脚本要删的目录里就包含它自己。
#
# 设计要点（按"考虑到的方面 → 怎么处理"列）：
#   · 数据永不触碰：data\、logs\ 一个字节都不动，只在不存在的把空目录补出来。
#     打包脚本那边也有闸门保证 zip 里 data\ 是空的，两头对得上。
#   · 先解压校验、后动老文件：顺序不能反 —— 一个下坏了的 zip 不该把用户唯一的程序目录清掉。
#   · 删之前先做占用预检：任何一个要删的文件被占用（最常见是浏览器还开着）就整体中止，
#     绝不进入"删了一半"的状态。
#   · 停机复用包里的 internal\stop.bat：停机哨兵的路径在 paths.js / tray.ps1 / stop.bat
#     三处有约定（AGENTS.md 第 4 条），这里不再写第四份。
#   · 不认识的根目录文件只报告、不删（用户自己放的笔记、快捷方式、下载的 zip）。
#   · 只有本来就开着 CoRead 才在更新后把它拉起来，否则不动。
#
# 用法（一般由 Update-CoRead.cmd 调用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Root <程序目录>
#   powershell ... -File update.ps1 -Root <程序目录> -Zip <新版本 zip>

param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Zip = ''
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host $m }
function Step($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "`n[错误] $m" -ForegroundColor Red; exit 1 }

# 程序自己占的格与文件（更新时整体替换）。判断依据 = 打包白名单，不是猜：
#   <包根>\internal\   node.exe / tray.ps1 / stop.bat / instructions-zh.txt / agent\ / receiver\
#   <包根>\extension\  浏览器插件
#   <包根>\assets\     图标等
#   <包根>\builtin\    内置回退图谱（现在必须为空，见打包脚本第 3 步注释）
# 另外三个根文件也归程序：入口、说明、以及本升级脚本的入口。
$PROG_DIRS = @('internal', 'extension', 'assets', 'builtin')
$PROG_ROOT_FILES = @('Start-CoRead.vbs', 'README-FIRST.txt', 'Update-CoRead.cmd')
# 老版本用过、现在没有的根文件：一并清掉（不清的话用户会看到好几个入口，不知道该点哪个）
$OBSOLETE_ROOT_FILES = @('01-START-CoRead.bat', 'unblock.bat')

Write-Host "`n=== CoRead 升级 ===" -ForegroundColor Cyan

# ── 1. 校验目标目录确实是一个 CoRead 包 ──────────────────────────────
if (-not (Test-Path -LiteralPath $Root)) { Fail "找不到这个目录：$Root" }
$root = (Resolve-Path -LiteralPath $Root).Path
if (-not (Test-Path -LiteralPath (Join-Path $root 'internal\tray.ps1'))) {
  Fail "这里不像是 CoRead 便携包（找不到 internal\tray.ps1）：`n  $root`n  请把本脚本和它所在的文件夹对应上，或直接解压一份新包。"
}
if ($root -like 'C:\Program Files*' -or $root -like 'C:\Program Files (x86)*') {
  Fail "程序装在 Program Files 下：替换文件需要管理员权限，中途失败会留下半新半旧的状态。`n  请把 CoRead 解压到普通文件夹（比如 D:\CoRead）再升级。"
}
Say "程序目录：$root"

function Get-PkgVersion([string]$dir) {
  # ⚠️ 必须显式按 UTF-8 读。PowerShell 5.1 的 Get-Content 不带 -Encoding 时按**系统 ANSI**
  # （中文 Windows 是 GBK）解码，而 manifest.json 里有中文（name / description）→ 读出来是
  # 乱码 → ConvertFrom-Json 直接抛错 → 这里返回空 → 用户看到"新包里读不到版本号"。
  # 实测踩过：单元测试里的假 manifest 只有 ASCII，所以全绿；一跑真包就挂。
  try {
    $raw = [System.IO.File]::ReadAllText((Join-Path $dir 'extension\manifest.json'), [System.Text.Encoding]::UTF8)
    $j = $raw | ConvertFrom-Json
    return [string]$j.version
  } catch { return '' }
}
$curVer = Get-PkgVersion $root

# ── 2. 拿到新版本的 zip ───────────────────────────────────────────────
if (-not $Zip) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = '选择新版本的 CoRead 便携包（zip）'
  $dlg.Filter = 'CoRead 便携包 (*.zip)|*.zip|所有文件 (*.*)|*.*'
  $dlg.CheckFileExists = $true
  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Say '已取消，什么都没改。'; exit 0 }
  $Zip = $dlg.FileName
}
if (-not (Test-Path -LiteralPath $Zip)) { Fail "找不到这个文件：$Zip" }
$Zip = (Resolve-Path -LiteralPath $Zip).Path
Say "新版本包：$Zip"
if ($curVer) { Say "当前版本：$curVer" }

# ── 3. 解压到临时目录（先解压、先校验，之后才动老文件）────────────────
# 顺序很重要：半个下坏的 zip 不该把用户唯一的程序目录清掉。
$tmp = Join-Path $env:TEMP ('coread-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
try {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
  # zip-slip 防护：条目名不许带 .. 或绝对路径（.NET Framework 的 ExtractToDirectory 不查这个）
  foreach ($e in $archive.Entries) {
    if ($e.FullName -match '\.\.' -or [System.IO.Path]::IsPathRooted($e.FullName)) {
      $bad = $e.FullName; $archive.Dispose(); Fail "这个 zip 里有可疑路径，已中止：$bad"
    }
  }
  $archive.Dispose()
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)
} catch {
  Fail "解压失败：$($_.Exception.Message)`n  如果文件是刚下载的，可能是没下完，重新下一遍再试。"
}
Step "已解压到临时目录"

# ── 4. 校验解压结果像个 CoRead 包，并读出新版本号 ─────────────────────
foreach ($need in @('internal\tray.ps1', 'extension\manifest.json', 'Start-CoRead.vbs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $tmp $need))) {
    Fail "这个 zip 不像是 CoRead 便携包（缺少 $need）。`n  请确认下载的是 CoRead-<版本>-portable.zip。"
  }
}
$newVer = Get-PkgVersion $tmp
if (-not $newVer) { Fail "新包里读不到版本号（extension\manifest.json），中止。" }
Say "新版本：$newVer"
if ($curVer -and $newVer -eq $curVer) { Say "  （和当前版本号一样：这会是一次同版本覆盖）" }
if ($curVer -and ([version]($newVer + '.0') -lt [version]($curVer + '.0'))) {
  Say "  ⚠️ 新包版本比当前低，这是降级。要继续就继续，出问题可用旧包再升回来。"
}

# ── 5. 停机：复用包里的 stop.bat（不自己再写一份停机哨兵路径）──────────
function Test-CoReadRunning([string]$r) {
  $hits = 0
  try {
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue)) {
      $exe = $null
      try { $exe = $p.ExecutablePath } catch {}
      if ($exe -and $exe.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { $hits++ }
    }
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue)) {
      $cl = $null
      try { $cl = $p.CommandLine } catch {}
      if ($cl -and $cl -like '*tray.ps1*' -and $cl -like "*$r*") { $hits++ }
    }
  } catch {}
  return ($hits -gt 0)
}

$wasRunning = Test-CoReadRunning $root
if ($wasRunning) {
  Say 'CoRead 正在运行，先让它停下来（会先把记忆存好）…'
  $stopBat = Join-Path $root 'internal\stop.bat'
  if (Test-Path -LiteralPath $stopBat) {
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$stopBat`"" -WindowStyle Hidden -PassThru
    $p.WaitForExit(150000) | Out-Null
  }
  # 再等一小会儿：stop.bat 杀掉进程后，文件句柄不一定立刻释放
  for ($i = 0; $i -lt 20; $i++) { if (-not (Test-CoReadRunning $root)) { break }; Start-Sleep -Milliseconds 500 }
  if (Test-CoReadRunning $root) {
    Fail "还有 CoRead 进程占着这些文件，没法替换。`n  请右键托盘图标退出（或用 internal\stop.bat），然后重新跑一遍。"
  }
  Step '已停机'
} else {
  Step 'CoRead 没在运行，跳过停机'
}

# ── 6. 占用预检：任何一个要删的文件被占用，就在**动手之前**中止 ────────
# 不这么做的话，可能出现"internal 删了一半、extension 删不掉"的半残状态。
# 最常见的占用者：浏览器还开着（它会盯着 unpacked 插件的目录）。
$toRemove = New-Object System.Collections.Generic.List[string]
foreach ($d in $PROG_DIRS) {
  $full = Join-Path $root $d
  if (Test-Path -LiteralPath $full) {
    foreach ($f in @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -EA SilentlyContinue)) { $toRemove.Add($f.FullName) }
  }
}
foreach ($f in ($PROG_ROOT_FILES + $OBSOLETE_ROOT_FILES)) {
  $full = Join-Path $root $f
  if (Test-Path -LiteralPath $full) { $toRemove.Add($full) }
}
$locked = @()
foreach ($f in $toRemove) {
  try {
    $h = [System.IO.File]::Open($f, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $h.Close()
  } catch { $locked += $f }
}
if ($locked.Count) {
  Write-Host "`n[错误] 有 $($locked.Count) 个文件正被占用，已中止（什么都没删）：" -ForegroundColor Red
  $locked | Select-Object -First 6 | ForEach-Object { Write-Host "   $_" }
  if ($locked.Count -gt 6) { Write-Host "   …另有 $($locked.Count - 6) 个" }
  Write-Host "`n  最常见的原因：浏览器还开着（它盯着 extension\ 这个目录）。关掉浏览器再跑一遍。"
  exit 1
}
Step "待替换 $($toRemove.Count) 个文件，没有占用"

# ── 7. 替换：程序那几格整体换掉，data\ 与 logs\ 只补不覆盖 ────────────
Write-Host '--- 替换程序文件 ---'
foreach ($d in $PROG_DIRS) {
  $full = Join-Path $root $d
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}
foreach ($f in ($PROG_ROOT_FILES + $OBSOLETE_ROOT_FILES)) {
  $full = Join-Path $root $f
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Force }
}
foreach ($d in $PROG_DIRS) {
  $src = Join-Path $tmp $d
  $dst = Join-Path $root $d
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force }
  else { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
}
foreach ($f in $PROG_ROOT_FILES) {
  $src = Join-Path $tmp $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $root $f) -Force }
}
# 用户数据：只在不存在的补空壳，绝不往里写、绝不删
$dataSrc = Join-Path $tmp 'data'
if (-not (Test-Path -LiteralPath (Join-Path $root 'data'))) {
  New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null
  if (Test-Path -LiteralPath (Join-Path $dataSrc 'README.txt')) {
    Copy-Item -LiteralPath (Join-Path $dataSrc 'README.txt') -Destination (Join-Path $root 'data\README.txt') -Force
  }
}
foreach ($d in @('config', 'profile', 'sessions', 'reading', 'runtime', 'toolbox')) {
  $p = Join-Path $root "data\$d"
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'logs'))) {
  New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null
}
Step '程序文件已替换'

# ── 8. 复核：新包里的文件是不是都落地了，版本号对不对 ──────────────────
$missing = @()
foreach ($d in $PROG_DIRS) {
  $src = Join-Path $tmp $d
  if (-not (Test-Path -LiteralPath $src)) { continue }
  foreach ($f in @(Get-ChildItem -LiteralPath $src -Recurse -File -Force -EA SilentlyContinue)) {
    $rel = $f.FullName.Substring($tmp.Length + 1)
    if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { $missing += $rel }
  }
}
if ($missing.Count) {
  Write-Host "`n[错误] 有 $($missing.Count) 个文件没落地，这次升级不算成功：" -ForegroundColor Red
  $missing | Select-Object -First 8 | ForEach-Object { Write-Host "   $_" }
  Write-Host "  程序目录：$root`n  建议：重新解压一份完整的新包到这个目录。"
  exit 1
}
$afterVer = Get-PkgVersion $root
if ($afterVer -ne $newVer) {
  Fail "更新后版本号对不上（期望 $newVer，实际 '$afterVer'）。请重新解压一份完整的新包。"
}

# ── 9. 报告 ───────────────────────────────────────────────────────────
Write-Host "`n=== 完成 ===" -ForegroundColor Green
Say "已更新：$($curVer) → $afterVer"
Say "你的数据一个字节都没动（data\ 与 logs\ 不参与更新）。"

# 根目录里"不是程序的文件"只报告不动：可能是用户自己的笔记、快捷方式、下载的 zip
$known = @($PROG_DIRS + $PROG_ROOT_FILES + $OBSOLETE_ROOT_FILES + @('data', 'logs'))
$others = @(Get-ChildItem -LiteralPath $root -Force -EA SilentlyContinue | Where-Object { $known -notcontains $_.Name })
if ($others.Count) {
  Write-Host ''
  Say '这些不是程序的文件，我没有动它们：'
  $others | Select-Object -First 8 | ForEach-Object { Say "  · $($_.Name)" }
  if ($others.Count -gt 8) { Say "  · …另有 $($others.Count - 8) 项" }
}

Write-Host ''
Write-Host '⚠️ 还有一步要你手动做：到浏览器的「扩展程序」页，点一次 CoRead 的「重新加载」。' -ForegroundColor Yellow
Write-Host '   （插件是按解压目录加载的，覆盖文件之后浏览器不会自己读新代码 —— 不点这一下，界面还是旧的。）'

# 日志（logs\ 是我们的目录，但只追加、不覆盖别的东西）
try {
  $line = "{0}  update {1} -> {2}  zip={3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $curVer, $afterVer, (Split-Path $Zip -Leaf)
  Add-Content -LiteralPath (Join-Path $root 'logs\update.log') -Value $line -Encoding UTF8
} catch {}

# 之前开着的话，把它拉起来（之前没开就不擅自启动）
if ($wasRunning) {
  $vbs = Join-Path $root 'Start-CoRead.vbs'
  if (Test-Path -LiteralPath $vbs) {
    Say ''
    Say 'CoRead 刚才是开着的，正在重新启动…'
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" | Out-Null
  }
}

# 清理临时目录（失败时上面的分支已经 exit，会留着现场便于排查）
try { Remove-Item -LiteralPath $tmp -Recurse -Force -EA SilentlyContinue } catch {}
exit 0
