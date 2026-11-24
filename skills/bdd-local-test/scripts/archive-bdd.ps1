<#
.SYNOPSIS
  將最終 BDD 輸出封存到本機封存庫（受測 repo 所有 worktree 之外），去重、驗證並登記到封存索引。

.DESCRIPTION
  流程：攤平舊 evidence.zip → 檢查圖片都已遮罩 → 收入受測當時的模組情境 → 截圖轉無損 WebP（有 Pillow 時）並改寫封存內的遮罩紀錄與報告連結
  → 依內容去重 → 打包並寫入 bdd-manifest.json → 逐檔驗證 SHA-256 → 搬到封存庫 → 在 index.jsonl 追加 created 事件，並把同主題的舊封存標為 superseded。

  封存位置優先序：-Destination（完整檔名）→ -ArchiveRoot → 環境變數 BDD_ARCHIVE_ROOT
  → .bdd/config.json 的 archiveRoot → 使用者目錄\bdd-archives\<主 checkout 資料夾名>。
  預設檔名：<封存庫>\<單號>\<輸出資料夾名>-<受測短 SHA>-<時間戳>.zip。

  內容相同的檔案只存一份，其餘記在 manifest 的 aliases；用 extract-bdd.ps1 解壓會還原成原本的每個檔名。
  任何一步失敗都不會留下半成品，也不會刪除來源檔案。

.PARAMETER Dir
  BDD 輸出資料夾（例如 .bdd/94542-topic）。

.PARAMETER ArchiveRoot
  本機封存庫根目錄（絕對路徑）。省略時依上述優先序決定。

.PARAMETER Destination
  直接指定封存檔完整路徑（相容舊版用法）。索引仍寫在封存庫根目錄。

.PARAMETER Commit
  受測程式 SHA。省略時取 verification.json 最後一輪的 head。

.PARAMETER Issue
  單號。省略時取輸出資料夾名稱開頭的數字。

.PARAMETER AllowUnmaskedReason
  明確允許未遮罩的圖片進入封存，並寫明理由（例如「遷移舊證據，未經遮罩檢查，不上傳 issue」）。
  理由與未遮罩清單會寫進 manifest；只用於不對外的本機封存，要上傳 issue 的封存不可使用。

.OUTPUTS
  JSON 摘要：封存檔路徑、SHA-256、大小、檔案數、去重數、是否已遮罩、是否超過附件上限、警告。

.EXAMPLE
  pwsh -NoProfile -File archive-bdd.ps1 -Dir .bdd/94542-topic
#>
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [string]$ArchiveRoot,
    [string]$Destination,
    [string]$Commit,
    [string]$Issue,
    [string]$AllowUnmaskedReason
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('archive', "--dir=$Dir")
if ($PSBoundParameters.ContainsKey('ArchiveRoot')) { $cliArgs += "--archive-root=$ArchiveRoot" }
if ($PSBoundParameters.ContainsKey('Destination')) { $cliArgs += "--destination=$Destination" }
if ($PSBoundParameters.ContainsKey('Commit')) { $cliArgs += "--commit=$Commit" }
if ($PSBoundParameters.ContainsKey('Issue')) { $cliArgs += "--issue=$Issue" }
if ($PSBoundParameters.ContainsKey('AllowUnmaskedReason')) { $cliArgs += "--allow-unmasked-reason=$AllowUnmaskedReason" }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
