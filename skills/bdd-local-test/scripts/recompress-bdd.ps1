<#
.SYNOPSIS
  把既有的 BDD 封存（PNG 截圖）重新壓縮成無損 WebP 版，路徑與檔名不變，並在封存索引記錄 recompressed。

.DESCRIPTION
  流程：核對封存檔與索引的 SHA-256 → 解到暫存目錄並依 manifest 還原 aliases → 截圖轉無損 WebP（逐像素驗證）
  → 改寫封存內的遮罩紀錄與報告連結 → 去重、打包、逐檔驗證 → 以新檔取代舊檔 → 索引追加 recompressed。
  索引狀態（例如 uploaded-verified）不變；issue 上的附件仍是原本的 PNG 版，索引以 issueCopySha256 記錄那一版。
  沒有可轉的截圖時不改動檔案（changed = false）。需要支援 WebP 的 Python Pillow。
  舊版沒有 manifest 的封存也可處理，結果會補上 manifest（legacy = true）。
  取得索引鎖、建立 .bak 並核對原檔 SHA-256 後才取代封存；索引追加成功後才移除備份，追加失敗則還原原檔。

.PARAMETER Archive
  要重新壓縮的封存檔。

.PARAMETER ArchiveRoot
  封存庫根目錄；省略時從封存檔往上找 index.jsonl。

.EXAMPLE
  pwsh -NoProfile -File recompress-bdd.ps1 -Archive ~/bdd-archives/bsaila/5349/5349-schedule-settings-list-ui-dfdbcad-20261001T180553.zip
#>
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [string]$ArchiveRoot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('recompress', "--archive=$Archive")
if ($PSBoundParameters.ContainsKey('ArchiveRoot')) { $cliArgs += "--archive-root=$ArchiveRoot" }
$cliOutput = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($cliOutput -join [Environment]::NewLine) }
$cliOutput
