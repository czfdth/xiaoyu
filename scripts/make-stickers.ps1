# 把她的画做成表情包：方形裁切 + 缩到 512，存成 images\梗-*.png
#
# 为什么这么做：
#   · 她的画本来就在 images\ 里（draw-*.png / sketch-*.png），只是尺寸不规则、不适合当表情
#   · 裁成方形后，qq_sticker 按 "梗-" 前缀就能挑到它们
#   · 全用她自己画的东西，没有版权问题
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\make-stickers.ps1
#       （可加 -Max 20 限制张数，-DryRun 只看会处理哪些）

param(
  [int]$Max = 20,
  [int]$Size = 512,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$imgDir = Join-Path $root 'images'
if (-not (Test-Path $imgDir)) { Write-Host "没有 images 目录：$imgDir"; exit 1 }

# 已有表情（避免重复处理）
$existing = @{}
Get-ChildItem $imgDir -Filter '梗-*.png' -File -ErrorAction SilentlyContinue | ForEach-Object {
  $existing[$_.Name] = $true
}

$sources = Get-ChildItem $imgDir -File | Where-Object { $_.Name -like 'draw-*.png' -or $_.Name -like 'sketch-*.png' } |
  Sort-Object LastWriteTime -Descending |
  Where-Object { -not $existing.ContainsKey('梗-' + $_.Name) } |
  Select-Object -First $Max

if (-not $sources) { Write-Host '没有需要处理的新画'; exit 0 }

$done = 0
foreach ($src in $sources) {
  $outName = '梗-' + $src.Name
  $outPath = Join-Path $imgDir $outName
  if ($DryRun) { Write-Host ("会处理: " + $src.Name + " -> " + $outName); continue }

  try {
    $img = [System.Drawing.Image]::FromFile($src.FullName)
    try {
      # 正方形裁切：取短边，居中
      $side = [Math]::Min($img.Width, $img.Height)
      $x = [int](($img.Width - $side) / 2)
      $y = [int](($img.Height - $side) / 2)

      $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)), $x, $y, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
      $g.Dispose()

      $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      $done++
    } finally { $img.Dispose() }
  } catch {
    Write-Host ("跳过 " + $src.Name + "：" + $_.Exception.Message)
  }
}

Write-Host ("完成：新做了 " + $done + " 张表情（总共 " + (Get-ChildItem $imgDir -Filter '梗-*.png' -File | Measure-Object).Count + " 张）")
