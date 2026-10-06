# 生成 CoRead 图标（托盘 + 浏览器插件）。
#
# 为什么要脚本而不是直接放几个 .ico：
#   1. 可复现——图标要改配色/形状时重跑一次，不用找设计稿；
#   2. 多尺寸一次出齐（托盘 16、插件 16/32/48/128）；
#   3. .ico 是容器格式，手工拼容易出错，这里按规范写。
#
# 设计（2026-10 定）：圆角方块底（蓝渐变）+ 白色书页 + 中缝 + 暖橙书签。
# 取向是**小尺寸优先**：托盘里只有 16×16，所以不要细线条、不要文字，
# 只保留"一本书 + 一个书签"两个大色块。
#
# 用法（仓库根）：
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
# 产物：
#   assets\icons\icon{16,32,48,128,256}.png
#   assets\icons\coread.ico        （多尺寸 ICO，托盘用）
#   extension\icons\icon{16,32,48,128}.png  （插件用，Chrome 要这几个尺寸）

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $repo 'assets\icons'
$extIconDir = Join-Path $repo 'extension\icons'
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
New-Item -ItemType Directory -Path $extIconDir -Force | Out-Null

$C_BG_TOP  = [System.Drawing.Color]::FromArgb(255, 47, 111, 176)   # #2F6FB0
$C_BG_BOT  = [System.Drawing.Color]::FromArgb(255, 30, 78, 130)    # #1E4E82
$C_SEAM    = [System.Drawing.Color]::FromArgb(255, 38, 92, 150)    # 中缝（比底色深一档）
$C_MARK    = [System.Drawing.Color]::FromArgb(255, 242, 169, 59)   # #F2A93B 书签

function New-CoReadIcon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  # 设计稿按 256×256 画，其它尺寸等比缩放（$u = 1 单位对应的像素）。
  # ⚠️ 16×16 必须**单独一套比例**：等比缩放时 6 单位的边距只剩 0.4 像素，
  # 圆角底几乎看不见、图标变成一张白纸。所以小尺寸直接给像素值、元素加粗。
  $u = $size / 256.0
  $px = { param($v) [int][Math]::Round($v * $u) }
  $small = ($size -le 20)

  # ── 1. 圆角方块底 ──────────────────────────────────────────────
  if ($small) { $pad = 1; $rad = 4 } else { $pad = & $px 6; $rad = & $px 52 }
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
  $d = $rad * 2
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bgPath.AddArc($rect.X,            $rect.Y,            $d, $d, 180, 90)
  $bgPath.AddArc(($rect.Right - $d), $rect.Y,            $d, $d, 270, 90)
  $bgPath.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d,   0, 90)
  $bgPath.AddArc($rect.X,            ($rect.Bottom - $d), $d, $d,  90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect, $C_BG_TOP, $C_BG_BOT, [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($bgBrush, $bgPath)

  # ── 2. 白色书页（圆角矩形）────────────────────────────────────
  # 大尺寸取向：占满约 78% 宽度（白块太小会显得空）。
  # 16×16 取向：留出 3 像素蓝边 + 2 像素中缝，保证"书"的形状还能读出来。
  if ($small) {
    $bx = 3; $by = 4; $bw = 10; $bh = 9; $brd = 2
  } else {
    $bx = & $px 28; $by = & $px 44; $bw = & $px 200; $bh = & $px 168
    $brd = (& $px 13) * 2
  }
  $bookRect = New-Object System.Drawing.Rectangle($bx, $by, $bw, $bh)
  $bookPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bookPath.AddArc($bookRect.X,             $bookRect.Y,             $brd, $brd, 180, 90)
  $bookPath.AddArc(($bookRect.Right - $brd), $bookRect.Y,             $brd, $brd, 270, 90)
  $bookPath.AddArc(($bookRect.Right - $brd), ($bookRect.Bottom - $brd), $brd, $brd,   0, 90)
  $bookPath.AddArc($bookRect.X,             ($bookRect.Bottom - $brd), $brd, $brd,  90, 90)
  $bookPath.CloseFigure()
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.FillPath($white, $bookPath)

  # ── 3. 中缝：把书分成左右两页 ─────────────────────────────────
  $seamW = if ($small) { 2 } else { [Math]::Max(1, (& $px 8)) }
  $seamX = [int][Math]::Round(($size - $seamW) / 2)
  $seam = New-Object System.Drawing.SolidBrush($C_SEAM)
  $g.FillRectangle($seam, $seamX, $by, $seamW, $bh)

  # ── 4. 书签（暖橙竖条，底边中间做燕尾缺口）─────────────────────
  if ($small) { $mx = 8; $my = 2; $mw = 4; $mh = 6; $notchRise = 2 }
  else { $mx = & $px 146; $my = & $px 30; $mw = & $px 40; $mh = & $px 74; $notchRise = & $px 20 }
  $amber = New-Object System.Drawing.SolidBrush($C_MARK)
  $g.FillRectangle($amber, $mx, $my, $mw, $mh)

  # 燕尾：用底色的三角形盖住底边中间那块。顶点在中点上方 → 中间凹进去、两侧留尖角。
  $notchTop = $my + $mh - $notchRise
  $p1 = New-Object System.Drawing.Point($mx,             ($my + $mh + 1))
  $p2 = New-Object System.Drawing.Point(($mx + $mw + 1), ($my + $mh + 1))
  $p3 = New-Object System.Drawing.Point(($mx + [int][Math]::Round($mw / 2)), $notchTop)
  $notch = New-Object System.Drawing.Drawing2D.GraphicsPath
  $notch.AddPolygon([System.Drawing.Point[]]@($p1, $p2, $p3))
  $g.FillPath($bgBrush, $notch)

  $g.Dispose()
  return $bmp
}

Write-Host '=== 生成 PNG ==='
$pngSizes = @(16, 32, 48, 128, 256)
foreach ($s in $pngSizes) {
  $bmp = New-CoReadIcon $s
  $bmp.Save((Join-Path $iconDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("  assets\icons\icon{0}.png" -f $s)
}

# 插件只认 16/32/48/128（Chrome 规范），复制过去
foreach ($s in @(16, 32, 48, 128)) {
  Copy-Item (Join-Path $iconDir "icon$s.png") (Join-Path $extIconDir "icon$s.png") -Force
  Write-Host ("  extension\icons\icon{0}.png" -f $s)
}

# 给"看效果"用的预览副本（不参与打包逻辑，纯粹方便人工确认）
Copy-Item (Join-Path $iconDir 'icon256.png') (Join-Path $iconDir 'icon-preview.png') -Force

# ── 组装多尺寸 ICO ────────────────────────────────────────────────
# ICO 是容器格式：6 字节头 + 每张图 16 字节目录项 + 各图数据。
# Vista 起允许目录项直接内嵌 PNG（这正是我们要的，省得转 BMP）。
Write-Host "`n=== 组装 coread.ico ==="
# 两条路线，都符合 ICO 规范，但**兼容性不同**（实测踩过）：
#   · 16/32/48/128 → 内嵌 PNG（Vista 起的写法，体积小）
#   · 256          → BMP(DIB) 条目。为什么不用 PNG：.NET 的 System.Drawing.Icon
#                    读 PNG 条目只认到 128，256 那档会静默取成 128。托盘虽然是
#                    System.Drawing 在用，但资源管理器/其他工具也会读这个文件，
#                    补一个 BMP 条目能让它在哪都认得出 256。
function ConvertTo-IcoDib([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  # BITMAPINFOHEADER：高度要写 2 倍（XOR 图 + AND 掩码）
  $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
  $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]0)
  $bw.Write([UInt32]($w * $h * 4)); $bw.Write([Int32]0); $bw.Write([Int32]0)
  $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  # XOR 位图：BGRA、自下而上
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $buf = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($data)
  for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($buf, $y * $stride, $w * 4) }
  # AND 掩码：32 位图里全 0 即可（透明度由 alpha 通道表达），每行按 4 字节对齐
  $maskStride = [int]([Math]::Ceiling($w / 32.0) * 4)
  $bw.Write((New-Object byte[] ($maskStride * $h)))
  $bw.Flush()
  $out = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  return $out
}

$entries = @()
foreach ($s in $pngSizes) {
  if ($s -eq 256) {
    $bmp256 = New-CoReadIcon 256
    $entries += [pscustomobject]@{ Size = $s; Bytes = (ConvertTo-IcoDib $bmp256) }
    $bmp256.Dispose()
  } else {
    $entries += [pscustomobject]@{ Size = $s; Bytes = [System.IO.File]::ReadAllBytes((Join-Path $iconDir "icon$s.png")) }
  }
}
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)                    # reserved
$bw.Write([UInt16]1)                    # type: 1 = icon
$bw.Write([UInt16]$entries.Count)       # 图像数量
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
  $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }   # 256 在 ICO 里记作 0
  $bw.Write([Byte]$dim)                 # 宽
  $bw.Write([Byte]$dim)                 # 高
  $bw.Write([Byte]0)                    # 调色板颜色数（真彩色写 0）
  $bw.Write([Byte]0)                    # reserved
  $bw.Write([UInt16]1)                  # 色彩平面
  $bw.Write([UInt16]32)                 # 位深
  $bw.Write([UInt32]$e.Bytes.Length)    # 数据长度
  $bw.Write([UInt32]$offset)            # 数据偏移
  $offset += $e.Bytes.Length
}
foreach ($e in $entries) { $bw.Write($e.Bytes) }
$bw.Flush()
$icoPath = Join-Path $iconDir 'coread.ico'
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Host ("  {0}  {1} 字节（{2} 个尺寸）" -f $icoPath.Replace($repo + '\', ''), (Get-Item $icoPath).Length, $entries.Count)

# 自检：确认每一档都真的读得出来（PNG 条目在 .NET 下读不到的现象就是这么发现的）
# 自检：确认托盘会用到的档位都读得出来。
# ⚠️ 256 那档**故意不在这里验**：.NET 的 System.Drawing.Icon 在 Win10 上按
# GetSystemMetrics 的上限取图，请求 256 只会拿回 128 —— 是 API 的限制，不是文件问题
# （已直接解析 ICO 目录表确认：256 条目存在、格式 BMP/DIB、数据 270 KB、长度合法）。
# 托盘只用 16/32/48；256 那档是给资源管理器大图标视图和别家 Shell API 用的。
Write-Host '  自检（按尺寸请求，读回的尺寸必须一致；256 见上方注释）：'
$bad = 0
foreach ($s in @(16, 32, 48, 128)) {
  try {
    $i = New-Object System.Drawing.Icon($icoPath, $s, $s)
    $ok = ($i.Width -eq $s)
    if (-not $ok) { $bad++ }
    Write-Host ("    {0,3} -> {1}x{2}  {3}" -f $s, $i.Width, $i.Height, $(if ($ok) { 'OK' } else { 'MISMATCH' }))
    $i.Dispose()
  } catch { $bad++; Write-Host ("    {0,3} -> 读取失败: {1}" -f $s, $_.Exception.Message) }
}
if ($bad) { Write-Host "  ⚠️ 有 $bad 档不对，检查上面的组装逻辑" -ForegroundColor Yellow }
else { Write-Host '  ✅ 托盘可用的档位全部可读' }

Write-Host "`n完成。"
