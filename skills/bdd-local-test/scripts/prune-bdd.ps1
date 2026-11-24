<#
.SYNOPSIS
  清理工作區裡已安全封存的 BDD 證據（evidence/ 與舊的 evidence.zip），預設只列出計畫不刪除。

.DESCRIPTION
  對 <Repo>/.bdd/ 底下每個輸出資料夾：
    1. 從封存索引找出同主題、目前狀態為 uploaded-verified、檔案仍存在且 SHA-256 與建立時相同的封存檔。
    2. 讀出這些封存檔 manifest 記錄的所有內容雜湊。封存內已轉成 WebP 的檔案，以 manifest 的 originalSha256 比對工作區的原圖。
    3. evidence/ 每個檔案、evidence.zip 每個項目的內容都在其中，才列為可清理。
  只刪除 evidence/ 與 evidence.zip；.feature、REPORT.md、verification.json、masking.json 一律保留。
  加上 -Apply 才會真的刪除。

.PARAMETER Repo
  要清理的 worktree 或主 checkout 路徑（只看這一個工作區的 .bdd/）。

.PARAMETER ArchiveRoot
  封存庫根目錄；省略時依 archive-bdd.ps1 相同規則決定。

.PARAMETER Apply
  實際刪除；未指定時只輸出計畫。

.PARAMETER AllowLocalOnly
  連 local-only／uploaded（尚未確認可下載）的封存也當作清理依據。
  用於把舊證據搬到本機封存庫：清理後本機封存庫就是唯一的完整副本，issue 上不一定有。

.EXAMPLE
  pwsh -NoProfile -File prune-bdd.ps1 -Repo .
  pwsh -NoProfile -File prune-bdd.ps1 -Repo . -Apply
  pwsh -NoProfile -File prune-bdd.ps1 -Repo . -AllowLocalOnly -Apply
#>
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$ArchiveRoot,
    [switch]$Apply,
    [switch]$AllowLocalOnly
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('prune', "--repo=$Repo")
if ($PSBoundParameters.ContainsKey('ArchiveRoot')) { $cliArgs += "--archive-root=$ArchiveRoot" }
if ($Apply) { $cliArgs += '--apply' }
if ($AllowLocalOnly) { $cliArgs += '--allow-local-only' }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
