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
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('mask-evidence', "--dir=$Dir", "--pattern=$Pattern", "--note=$Note")
if ($Status) { $cliArgs += '--status' }
if ($Mark) { $cliArgs += '--mark' }
if ($Apply) { $cliArgs += '--apply' }
if ($Force) { $cliArgs += '--force' }
if ($Method) { $cliArgs += "--method=$Method" }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
