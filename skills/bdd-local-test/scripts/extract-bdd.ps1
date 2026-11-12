<#
.SYNOPSIS
  解開 archive-bdd.ps1 產生的 BDD 封存，依 manifest 還原去重的檔案並逐檔驗證 SHA-256。

.DESCRIPTION
  ZIP 內第一層是輸出資料夾名稱（例如 5350-save-bar-layout/），解到 -To 底下後即為 <To>/<資料夾名>/。
  有 bdd-manifest.json 時（manifest 本身不解出，資料夾可直接再交給 archive-bdd.ps1）：把 aliases 指向的檔案複製回原本的檔名，並確認每個檔案的 SHA-256 與 manifest 相同。
  沒有 manifest（舊版封存）時：只做一般解壓。
  每個 ZIP 檔案項目只解壓一次，寫入暫存檔時一併計算 SHA-256，驗證完畢才移入目的地。
  目標已有同名檔案時，內容相同就略過、不同就停止，不會覆蓋。

.PARAMETER Archive
  封存檔路徑。

.PARAMETER To
  解壓目的地目錄（例如 .bdd 目錄，解完會得到 .bdd/<資料夾名>/）。

.EXAMPLE
  pwsh -NoProfile -File extract-bdd.ps1 -Archive ~/bdd-archives/bsaila/5350/5350-save-bar-layout-12c76ee-20261001T160300.zip -To .bdd
#>
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$To
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddExtract.psm1') -Force

Expand-BddArchive -Archive $Archive -To $To |
    Select-Object archive, destination, folder, hasManifest, written, restoredAliases, skippedIdentical, verifiedFiles |
    ConvertTo-Json
