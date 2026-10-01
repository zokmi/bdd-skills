<#
.SYNOPSIS
  處理並登記 BDD 截圖的個資遮罩，結果寫入輸出資料夾的 masking.json，供 archive-bdd.ps1 封存前檢查。

.DESCRIPTION
  三種模式擇一：
    -Status：列出 evidence/ 每張圖片的遮罩狀態（masked／unmasked／stale：登記後檔案又被改過）。
    -Apply ：依 .bdd/config.json 的 mask.rects 規則，把符合檔名的圖片指定區域塗成純色後覆寫原檔並登記 method=rect。
             已有有效登記的圖片略過（加 -Force 重新套用）。只用 Windows 內建的 System.Drawing，不需安裝其他套件。
    -Mark  ：截圖時已用 CSS 遮罩（mask.selectors）就登記 method=css；確認畫面本來就沒有個資則登記 method=exempt 並以 -Note 寫明理由。

  mask.rects 規則格式：{ "name": "header-avatar", "glob": "*_SB-10_*.png", "rect": [左, 上, 右, 下], "color": "#FFFFFF" }
  座標以像素計，超出圖片範圍會自動截到邊界。

.EXAMPLE
  pwsh -NoProfile -File mask-evidence.ps1 -Dir .bdd/5350-save-bar-layout -Status
  pwsh -NoProfile -File mask-evidence.ps1 -Dir .bdd/5350-save-bar-layout -Apply
  pwsh -NoProfile -File mask-evidence.ps1 -Dir .bdd/5350-save-bar-layout -Mark -Pattern 'R3_*' -Method css
  pwsh -NoProfile -File mask-evidence.ps1 -Dir .bdd/5350-save-bar-layout -Mark -Pattern 'R1_SB-07_*' -Method exempt -Note '登入前頁面，無帳號資訊'
#>
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [switch]$Status,
    [switch]$Apply,
    [switch]$Mark,
    [switch]$Force,
    [string]$Pattern = '*',
    [ValidateSet('css', 'exempt')][string]$Method,
    [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force

if (@($Status, $Apply, $Mark | Where-Object { $_ }).Count -ne 1) { throw '請擇一指定 -Status、-Apply 或 -Mark' }
$source = Get-NormalizedPath $Dir
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "BDD 輸出目錄不存在：$source" }
$images = @(Get-EvidenceFiles $source | Where-Object { Test-ImageFile $_.relative })
$ledger = Read-MaskLedger $source
$now = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')

# 判斷某張圖片目前的遮罩狀態
function Get-MaskState($Image) {
    $record = $ledger[$Image.relative]
    if (-not $record) { return 'unmasked' }
    if ($record.sha256 -ne (Get-Sha256Hex -Path $Image.file.FullName)) { return 'stale' }
    'masked'
}

if ($Status) {
    $rows = @($images | ForEach-Object {
        $record = $ledger[$_.relative]
        [pscustomobject]@{ file = $_.relative; state = (Get-MaskState $_); method = if ($record) { $record.method } else { $null } }
    })
    [pscustomobject]@{
        dir = $source
        total = $rows.Count
        masked = @($rows | Where-Object state -eq 'masked').Count
        unmasked = @($rows | Where-Object state -ne 'masked' | ForEach-Object { $_.file })
        files = $rows
    } | ConvertTo-Json -Depth 4
    return
}

if ($Mark) {
    if (-not $Method) { throw '-Mark 需要 -Method css 或 exempt' }
    if ($Method -eq 'exempt' -and -not $Note.Trim()) { throw 'exempt 必須以 -Note 寫明為何不需遮罩' }
    $targets = @($images | Where-Object { $_.file.Name -like $Pattern -or $_.relative -like $Pattern })
    if (-not $targets.Count) { throw "沒有圖片符合 $Pattern" }
    foreach ($t in $targets) {
        $ledger[$t.relative] = [ordered]@{ method = $Method; sha256 = (Get-Sha256Hex -Path $t.file.FullName); note = $Note; at = $now }
    }
    Save-MaskLedger $source $ledger
    [pscustomobject]@{ dir = $source; method = $Method; marked = @($targets | ForEach-Object { $_.relative }) } | ConvertTo-Json -Depth 3
    return
}

# -Apply：依座標規則塗色
Add-Type -AssemblyName System.Drawing
$rules = @((Get-MaskConfig (Get-BddConfig $source).data).rects)
if (-not $rules.Count) { throw '.bdd/config.json 沒有 mask.rects 規則可套用' }
foreach ($r in $rules) {
    if (-not $r.glob -or @($r.rect).Count -ne 4) { throw "mask.rects 規則格式錯誤（需要 glob 與四個座標的 rect）：$($r | ConvertTo-Json -Compress)" }
}

$applied = @(); $skipped = @()
foreach ($img in $images) {
    $matched = @($rules | Where-Object { $img.file.Name -like $_.glob -or $img.relative -like $_.glob })
    if (-not $matched.Count) { continue }
    if (-not $Force -and (Get-MaskState $img) -eq 'masked') { $skipped += $img.relative; continue }

    $path = $img.file.FullName
    $bytes = [IO.File]::ReadAllBytes($path)
    $memory = [IO.MemoryStream]::new($bytes)
    $original = [Drawing.Image]::FromStream($memory)
    # 調色盤格式的 PNG 不能直接繪圖，一律轉成 32 位元點陣圖再處理
    $canvas = [Drawing.Bitmap]::new($original.Width, $original.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $g = [Drawing.Graphics]::FromImage($canvas)
        try {
            $g.DrawImage($original, 0, 0, $original.Width, $original.Height)
            foreach ($r in $matched) {
                $x1 = [Math]::Max(0, [int]$r.rect[0]); $y1 = [Math]::Max(0, [int]$r.rect[1])
                $x2 = [Math]::Min($canvas.Width, [int]$r.rect[2]); $y2 = [Math]::Min($canvas.Height, [int]$r.rect[3])
                if ($x2 -le $x1 -or $y2 -le $y1) { continue }
                $color = [Drawing.ColorTranslator]::FromHtml($(if ($r.PSObject.Properties['color'] -and $r.color) { $r.color } else { '#FFFFFF' }))
                $brush = [Drawing.SolidBrush]::new($color)
                try { $g.FillRectangle($brush, $x1, $y1, $x2 - $x1, $y2 - $y1) } finally { $brush.Dispose() }
            }
        } finally { $g.Dispose() }
        $format = switch ($img.file.Extension.ToLowerInvariant()) {
            { $_ -in '.jpg', '.jpeg' } { [Drawing.Imaging.ImageFormat]::Jpeg }
            '.gif' { [Drawing.Imaging.ImageFormat]::Gif }
            '.bmp' { [Drawing.Imaging.ImageFormat]::Bmp }
            '.png' { [Drawing.Imaging.ImageFormat]::Png }
            default { throw "不支援以座標遮罩此格式：$($img.relative)" }
        }
        $original.Dispose(); $memory.Dispose()
        $temporary = "$path.masking.tmp"
        $canvas.Save($temporary, $format)
        Move-Item -LiteralPath $temporary -Destination $path -Force
    } finally {
        $canvas.Dispose(); $original.Dispose(); $memory.Dispose()
        if (Test-Path -LiteralPath "$path.masking.tmp") { Remove-Item -LiteralPath "$path.masking.tmp" -Force }
    }
    $ledger[$img.relative] = [ordered]@{
        method = 'rect'; rules = @($matched | ForEach-Object { if ($_.PSObject.Properties['name']) { $_.name } else { $_.glob } })
        sha256 = (Get-Sha256Hex -Path $path); note = $Note; at = $now
    }
    $applied += $img.relative
}
Save-MaskLedger $source $ledger
[pscustomobject]@{ dir = $source; applied = $applied; skippedAlreadyMasked = $skipped } | ConvertTo-Json -Depth 3
