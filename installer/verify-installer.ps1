# CoRead 安装包自检
#
# 为什么要单独有这个脚本：安装程序的完整流程（安装 → 升级 → 卸载）
# 需要真实可运行的 Windows 环境，自动化沙箱里跑不起来（GUI 进程会被拦、
# 写注册表被拒）。这个脚本把该验的都验一遍，你双击或右键用 PowerShell 运行即可。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File installer\verify-installer.ps1
#
# 它做五件事：
#   1. 检查安装包是否存在
#   2. 静默安装到临时目录，核对每一类文件是否到位
#   3. 写入"假用户数据"，再覆盖安装一次，验证升级不会清掉数据 ★最关键
#   4. 卸载，验证退出码与数据保留
#   5. 报告结论

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$setup = Get-ChildItem (Join-Path $PSScriptRoot 'build\out') -Filter 'CoRead-Setup-*.exe' -EA SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

$pass = 0; $fail = 0
function Ok($m)   { Write-Host "  [通过] $m" -ForegroundColor Green;  $script:pass++ }
function Bad($m)  { Write-Host "  [失败] $m" -ForegroundColor Red;    $script:fail++ }
function Info($m) { Write-Host "  $m" -ForegroundColor Gray }

Write-Host "`n===== CoRead 安装包自检 =====`n" -ForegroundColor Cyan

# ── 1. 找安装包 ────────────────────────────────────────────────────
if (-not $setup) {
  Write-Host "找不到安装包。请先运行 installer\build-installer.bat" -ForegroundColor Red
  exit 1
}
Write-Host "安装包: $($setup.Name)  ($([math]::Round($setup.Length/1MB,1)) MB)"
if ($setup.Length -gt 10MB) { Ok '安装包大小正常（含 Node 运行时）' } else { Bad '安装包过小，可能打包不完整' }

# ── 2. 安装到临时目录 ──────────────────────────────────────────────
$dir = Join-Path $env:TEMP ('coread-verify-' + (Get-Random))
$log = Join-Path $env:TEMP ('coread-verify-install.log')
Remove-Item $log -Force -EA SilentlyContinue
Write-Host "`n--- 第 1 步：安装到 $dir ---"
# /TASKS=desktopicon 表示只勾"桌面快捷方式"，从而不选"开机自启"——避免改动你的系统设置
# （写成 /TASKS= 空值在某些环境下会让安装程序行为异常，所以这里显式给一个无害的任务名）
$p = Start-Process -FilePath $setup.FullName -Wait -PassThru -ArgumentList @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=desktopicon', "/DIR=$dir", "/LOG=$log"
)

# 安装失败就立即中止。
# 为什么必须中止：继续往下跑的话，"第 4 步 用户数据保留"会变成假阳性——
# 那份数据是写在本来就没被安装覆盖的目录里，跟"升级保数据"毫无关系。
# 实测吃过这个亏：报告显示"数据全部保留 ✅"，实际上第一步就压根没装上。
if ($p.ExitCode -ne 0) {
  Bad "安装退出码 $($p.ExitCode)，期望 0 —— 安装没成功，后面的检查没有意义，已中止"
  Write-Host "`n排查线索：" -ForegroundColor Yellow
  Write-Host "  · 安装目录是否创建: $(Test-Path $dir)"
  Write-Host "  · 安装日志是否生成: $(Test-Path $log)"
  if (Test-Path $log) {
    Write-Host "  · 日志最后 15 行："
    Get-Content $log | Select-Object -Last 15 | ForEach-Object { Write-Host "      $_" }
  } else {
    Write-Host "  · 没有日志 → 安装程序在写日志之前就退出了。" -ForegroundColor Yellow
    Write-Host "    通常是被安全软件拦下，或静默模式不被允许。" -ForegroundColor Yellow
    Write-Host "    建议改成手动双击安装包看向导是否正常弹出：" -ForegroundColor Yellow
    Write-Host "      $($setup.FullName)" -ForegroundColor Yellow
  }
  Remove-Item $dir -Recurse -Force -EA SilentlyContinue
  Write-Host "`n===== 结论 =====" -ForegroundColor Cyan
  Write-Host "  通过 $pass 项 / 失败 $fail 项" -ForegroundColor Red
  Read-Host "`n按回车退出"
  exit 1
}
Ok "安装成功（退出码 0）"

$expect = @{
  'node.exe'                                        = 'Node 运行时（用户不需要自己装 Node）'
  'LICENSE.node.txt'                                = 'Node 的许可证（随包分发必须带）'
  'agent\index.js'                                  = '共读引擎入口'
  'agent\lib\chat-store.js'                         = '聊天库模块'
  'agent\api-config.json'                           = 'API 配置模板（空值，不含密钥）'
  'agent\data'                                      = '用户数据目录（画像/图谱）'
  'agent\scripts\data\knowledge-graph-results.json' = '图谱回退数据（运行时要读）'
  'receiver\index.js'                               = '接收端入口'
  'receiver\inbox'                                  = '收件目录（标注/聊天库）'
  'receiver\books'                                  = '书库缓存目录'
  'receiver\toolbox'                                = '翻译记录目录'
  'extension\manifest.json'                         = '插件清单（安装向导要指向它）'
  'extension\vendor\pdfjs\pdf.min.mjs'              = '内置 pdf.js（阅读器依赖）'
  'tray.ps1'                                        = '托盘程序'
  'run-hidden.vbs'                                  = '无窗口启动器'
  'stop.bat'                                        = '停止脚本'
  'unins000.exe'                                    = '卸载程序'
}
Write-Host "`n--- 第 2 步：核对安装内容 ---"
foreach ($k in $expect.Keys | Sort-Object) {
  if (Test-Path (Join-Path $dir $k)) { Ok "$k  —— $($expect[$k])" }
  else { Bad "$k 缺失（$($expect[$k])）" }
}

# 确认没有把开发机的私人数据带进来
Write-Host "`n--- 第 3 步：确认没有夹带私人数据 ---"
$leak = @()
foreach ($pat in @('*.db', '*.db-wal', '*.jsonl', '.env')) {
  Get-ChildItem $dir -Recurse -File -Force -Filter $pat -EA SilentlyContinue |
    Where-Object { $_.Name -ne '.env.example' } | ForEach-Object { $leak += $_.FullName }
}
$cfg = Join-Path $dir 'agent\api-config.json'
if ((Test-Path $cfg) -and ((Get-Content $cfg -Raw) -match 'sk-[A-Za-z0-9]{10}')) { $leak += $cfg }
if ($leak.Count -eq 0) { Ok '无私人数据、无密钥' } else { $leak | ForEach-Object { Bad "夹带了 $_" } }

# ── 4. 升级测试：这是最关键的 ─────────────────────────────────────
Write-Host "`n--- 第 4 步：写入假用户数据，然后覆盖升级 ★关键 ---"
$fake = @{
  'agent\data\knowledge-graph.json'      = '{"nodes":[{"id":"n1"}],"edges":[]}'
  'agent\api-config.json'                = '{"apiBase":"https://api.deepseek.com","apiKey":"sk-faketest123456","model":"deepseek-chat"}'
  'receiver\inbox\annotations.jsonl'     = "{`"selectedText`":`"测试划线`"}`n"
  'receiver\books\demo\chapter1.txt'     = '章节正文测试'
  'receiver\toolbox\history.jsonl'       = "{`"src`":`"原文`",`"dst`":`"译文`"}`n"
}
foreach ($k in $fake.Keys) {
  $f = Join-Path $dir $k
  New-Item -ItemType Directory -Path (Split-Path $f -Parent) -Force | Out-Null
  Set-Content -Path $f -Value $fake[$k] -NoNewline -Encoding UTF8
}
Info "已写入 $($fake.Count) 项假数据"

$p2 = Start-Process -FilePath $setup.FullName -Wait -PassThru -ArgumentList @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=desktopicon', "/DIR=$dir"
)
if ($p2.ExitCode -eq 0) {
  Ok "覆盖安装成功（退出码 0）"
} else {
  Bad "覆盖安装退出码 $($p2.ExitCode)，期望 0 —— 下面的"数据保留"结论不可信，已跳过"
  Info '（第一次装成功后，覆盖安装同样应该成功；失败说明环境有拦截）'
}

foreach ($k in ($fake.Keys | Sort-Object)) {
  $f = Join-Path $dir $k
  if (-not (Test-Path $f)) { Bad "$k 在升级后丢失了！" ; continue }
  $now = (Get-Content $f -Raw).Trim()
  if ($now -eq $fake[$k].Trim()) { Ok "$k 完好保留" } else { Bad "$k 内容被升级改动" }
}

# ── 5. 卸载 ────────────────────────────────────────────────────────
Write-Host "`n--- 第 5 步：卸载（保留用户数据）---"
$unins = Join-Path $dir 'unins000.exe'
if (Test-Path $unins) {
  $p3 = Start-Process -FilePath $unins -Wait -PassThru -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/KEEPUSERDATA')
  Info "卸载退出码: $($p3.ExitCode)"
  $stillThere = @($fake.Keys | Where-Object { Test-Path (Join-Path $dir $_) }).Count
  if ($stillThere -eq $fake.Count) { Ok "卸载保留了全部 $stillThere 项用户数据" }
  else { Bad "卸载后只剩 $stillThere / $($fake.Count) 项数据" }
} else { Bad '找不到卸载程序' }

# ── 6. 收尾 ────────────────────────────────────────────────────────
Write-Host "`n--- 第 6 步：清理测试目录 ---"
Remove-Item $dir -Recurse -Force -EA SilentlyContinue
if (-not (Test-Path $dir)) { Ok '测试目录已清空' } else { Info "测试目录需手动删除: $dir" }

Write-Host "`n===== 结论 =====" -ForegroundColor Cyan
Write-Host "  通过 $pass 项 / 失败 $fail 项" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
if ($fail -eq 0) {
  Write-Host "`n  安装包可以交付：安装、升级保数据、卸载留数据 三条都通过。`n" -ForegroundColor Green
} else {
  Write-Host "`n  有 $fail 项未通过，请把上面的 [失败] 行发我。`n" -ForegroundColor Red
}
Read-Host "按回车退出"
