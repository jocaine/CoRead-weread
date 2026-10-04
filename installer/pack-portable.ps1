# 生成安装包用的"暂存目录"（staging）
#
# 为什么需要它：Inno Setup 需要一个干净的输入目录。直接把仓库目录喂给它，
# 会把开发机上的个人数据一起打进安装包——实测过一次，误带了：
#   12 本真实书籍（receiver/books）、聊天库、标注、以及含 API Key 明文的 agent/api-config.json
#
# 用法（在仓库根目录）：
#   pwsh -File installer\pack-portable.ps1
#
# 产物：installer\build\app\  ← 安装包的全部输入

param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'build\app'),
  [string]$NodeVersion = 'v24.15.0',
  [string]$NodeDir = '',          # 已解压的官方 Node 目录；留空则用缓存的下载
  [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $PSScriptRoot 'build'

function Write-Step($msg) { Write-Host "  $msg" }
function Fail($msg) { Write-Host "[错误] $msg" -ForegroundColor Red; exit 1 }

Write-Host "`n=== CoRead 安装包暂存 ===" 
Write-Host "仓库: $repo"
Write-Host "输出: $OutDir`n"

# ── 1. 准备干净输出目录 ────────────────────────────────────────────
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# ── 2. Node 运行时（只带 node.exe + 它自己的许可证）─────────────────
if (-not $SkipNode) {
  Write-Host '--- Node 运行时 ---'
  $nodeSrc = $NodeDir
  if (-not $nodeSrc) {
    # 优先用已缓存的下载，避免每次联网
    $zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
    $extracted = Join-Path $env:TEMP ("node-official\node-{0}-win-x64" -f $NodeVersion)
    if (-not (Test-Path $extracted)) {
      if (-not (Test-Path $zip)) {
        Write-Step "下载官方分发包 node-$NodeVersion-win-x64.zip ..."
        # 用 node 自带的 fetch（它的 TLS 不依赖系统凭据库）
        node -e "const fs=require('fs');fetch('https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const f=fs.createWriteStream(process.argv[1]);for await(const c of r.body)f.write(c);await new Promise(x=>f.end(x));console.log('已下载')}).catch(e=>{console.error(e.message);process.exit(1)})" $zip
        if ($LASTEXITCODE -ne 0) { Fail "下载失败。可手动下载后解压，再用 -NodeDir 指定目录。" }
      }
      Write-Step "解压 ..."
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, (Join-Path $env:TEMP 'node-official'))
    }
    $nodeSrc = $extracted
  }
  $nodeExe = Join-Path $nodeSrc 'node.exe'
  if (-not (Test-Path $nodeExe)) { Fail "找不到 node.exe：$nodeExe" }
  Copy-Item $nodeExe $OutDir
  $lic = Join-Path $nodeSrc 'LICENSE'
  if (Test-Path $lic) { Copy-Item $lic (Join-Path $OutDir 'LICENSE.node.txt') }
  Write-Step ("node.exe  " + [math]::Round((Get-Item $nodeExe).Length/1MB,1) + ' MB')
  Write-Step '（不带 npm / npx / corepack / node_modules —— 本项目零第三方依赖，运行时用不到）'
}

# ── 3. agent：运行需要的文件（白名单，不整目录复制）────────────────
Write-Host "`n--- agent ---"
$agentOut = Join-Path $OutDir 'agent'
New-Item -ItemType Directory -Path $agentOut -Force | Out-Null
Copy-Item (Join-Path $repo 'agent\index.js')     $agentOut
Copy-Item (Join-Path $repo 'agent\package.json') $agentOut
Copy-Item (Join-Path $repo 'agent\lib')          $agentOut -Recurse
if (Test-Path (Join-Path $repo 'agent\.env.example')) { Copy-Item (Join-Path $repo 'agent\.env.example') $agentOut }

# 运行时会被读取的离线数据（agent/index.js 里 RESULTS_GRAPH_FILE 指向这里）
$dataOut = Join-Path $agentOut 'scripts\data'
New-Item -ItemType Directory -Path $dataOut -Force | Out-Null
foreach ($f in @('knowledge-graph-results.json', 'knowledge-graph-demo.json', 'smoke-stack-sequences.json', 'judge-smoke-cases.json')) {
  $p = Join-Path $repo "agent\scripts\data\$f"
  if (Test-Path $p) { Copy-Item $p $dataOut; Write-Step "scripts/data/$f" }
}

# 用户数据目录：建成空的，由程序运行时写入（**升级时绝不覆盖**）
New-Item -ItemType Directory -Path (Join-Path $agentOut 'data') -Force | Out-Null

# ── 4. receiver ────────────────────────────────────────────────────
Write-Host "`n--- receiver ---"
$recvOut = Join-Path $OutDir 'receiver'
New-Item -ItemType Directory -Path $recvOut -Force | Out-Null
foreach ($f in @('index.js', 'package.json', 'graph-data.js')) {
  $p = Join-Path $repo "receiver\$f"
  if (Test-Path $p) { Copy-Item $p $recvOut }
}
foreach ($d in @('inbox', 'books', 'toolbox')) {
  New-Item -ItemType Directory -Path (Join-Path $recvOut $d) -Force | Out-Null
}

# ── 5. extension（随包分发，供安装向导指向）────────────────────────
Write-Host "`n--- extension ---"
Copy-Item (Join-Path $repo 'extension') $OutDir -Recurse
Remove-Item (Join-Path $OutDir 'extension\test') -Recurse -Force -EA SilentlyContinue
# 沙箱/开发用的东西不带
Get-ChildItem (Join-Path $OutDir 'extension') -Recurse -File -Force -Include '*.md' -EA SilentlyContinue |
  Where-Object { $_.Name -ne 'README.md' -or $_.DirectoryName -notlike '*vendor*' } |
  Remove-Item -Force -EA SilentlyContinue

# ── 6. 启动器（托盘 + 无窗口启动 + 停止脚本）──────────────────────
Write-Host "`n--- 启动器 ---"
foreach ($f in @('tray.ps1', 'run-hidden.vbs', 'stop.bat')) {
  $p = Join-Path $PSScriptRoot "launcher\$f"
  if (-not (Test-Path $p)) { Fail "缺少启动器文件：launcher\$f" }
  $dst = Join-Path $OutDir $f
  Copy-Item $p $dst
  Write-Step $f
}

# 保证 .ps1 带 UTF-8 BOM。
# 为什么必须做：Windows PowerShell 5.1 会把没有 BOM 的 UTF-8 文件按系统 ANSI
# （中文 Windows 上是 GBK）解析，脚本里的中文会整体乱码、语法直接崩，
# 而且报错信息指向的位置完全是错的，极难排查。实测踩过。
# 注意：编辑器的"保存"经常会把 BOM 丢掉，所以这里每次构建都强制补一遍。
foreach ($ps1 in Get-ChildItem $OutDir -Recurse -File -Filter '*.ps1' -EA SilentlyContinue) {
  $bytes = [System.IO.File]::ReadAllBytes($ps1.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if (-not $hasBom) {
    [System.IO.File]::WriteAllBytes($ps1.FullName, ([byte[]](0xEF, 0xBB, 0xBF) + $bytes))
    Write-Step "已为 $($ps1.Name) 补 UTF-8 BOM（PowerShell 5.1 必需）"
  }
}

# ── 7. API 配置模板（空值，避免把开发机的 Key 带出去）─────────────
$cfgTemplate = Join-Path $PSScriptRoot 'launcher\api-config.template.json'
if (Test-Path $cfgTemplate) { Copy-Item $cfgTemplate (Join-Path $agentOut 'api-config.json') }

# ── 7b. "目录占位"文件：安装程序用它建出空的用户数据目录 ────────────
# 放在暂存根目录，.iss 里用 build\app\.keep 引用（.iss 的相对路径是相对脚本
# 所在目录解析的，所以不能在 .iss 里写 installer\launcher\.keep，那会变成
# installer\installer\... —— 这个坑踩过一次）
Copy-Item (Join-Path $PSScriptRoot 'launcher\.keep') (Join-Path $OutDir '.keep') -Force

# ── 8. 敏感数据闸门：任何个人数据/密钥出现就中止 ────────────────────
Write-Host "`n--- 敏感数据检查 ---"
$violations = @()
foreach ($pat in @('*.env', 'api-config.json', '*.db', '*.db-wal', '*.db-shm', '*.jsonl', 'topic_stack.json', 'hist_cursors.json', '*.bak', '*.bak-*', '*.out', 'profile.md', 'soul.md')) {
  Get-ChildItem $OutDir -Recurse -File -Force -Filter $pat -EA SilentlyContinue |
    Where-Object { $_.Name -ne '.env.example' -and $_.Name -ne 'api-config.json' } |
    ForEach-Object { $violations += $_.FullName }
}
# api-config.json 允许存在，但必须是全空模板
$cfg = Join-Path $agentOut 'api-config.json'
if (Test-Path $cfg) {
  $txt = Get-Content $cfg -Raw
  if ($txt -match 'sk-[A-Za-z0-9]') { $violations += "$cfg （含疑似 API Key）" }
}
# 用户数据目录必须为空
foreach ($d in @('agent\data', 'receiver\inbox', 'receiver\books', 'receiver\toolbox', 'agent\scripts\data')) {
  $full = Join-Path $OutDir $d
  if (Test-Path $full) {
    $files = Get-ChildItem $full -Recurse -File -Force -EA SilentlyContinue
    # scripts\data 是允许有内容的例外
    if ($d -ne 'agent\scripts\data' -and $files) {
      $files | ForEach-Object { $violations += "$($_.FullName) （用户数据目录应为空）" }
    }
  }
}
if ($violations.Count) {
  Write-Host '❌ 发现不该打包的内容，已中止：' -ForegroundColor Red
  $violations | Select-Object -First 20 | ForEach-Object { Write-Host "   $_" }
  exit 1
}
Write-Step '✅ 无个人数据、无密钥、无备份残留'

# ── 9. 汇总 ────────────────────────────────────────────────────────
$all = Get-ChildItem $OutDir -Recurse -File -Force
Write-Host "`n=== 暂存完成 ==="
Get-ChildItem $OutDir -Force | ForEach-Object {
  if ($_.PSIsContainer) {
    $s = (Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    $c = (Get-ChildItem $_.FullName -Recurse -File -Force -EA SilentlyContinue).Count
    Write-Host ("  {0,-22} {1,4} 个文件  {2,8} MB" -f ($_.Name + '\'), $c, [math]::Round($s/1MB,1))
  } else {
    Write-Host ("  {0,-22} {1,4} 个文件  {2,8} MB" -f $_.Name, 1, [math]::Round($_.Length/1MB,1))
  }
}
Write-Host ("  {0,-22} {1,4} 个文件  {2,8} MB" -f '合计', $all.Count, [math]::Round(($all | Measure-Object Length -Sum).Sum/1MB,1))
