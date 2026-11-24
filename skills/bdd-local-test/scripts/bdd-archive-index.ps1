<#
.SYNOPSIS
  查詢或更新本機 BDD 封存索引（index.jsonl）。

.DESCRIPTION
  -List：列出每個封存檔目前的狀態（可用 -Issue／-Topic 篩選）。
  -Mark：登記某個封存檔的新狀態，例如上傳 issue 並確認可下載後標為 uploaded-verified。
         登記前會重新計算封存檔 SHA-256，與建立時的紀錄不同就拒絕（避免登記到被改過或壞掉的檔案）。
         uploaded／uploaded-verified 必須帶 -Attachment（附件 ID 或網址），prune-bdd.ps1 只認 uploaded-verified。
  -Import：把舊版產生的封存 ZIP（沒有 bdd-manifest.json）複製進封存庫的 <單號>/legacy/，核對 SHA-256 後登記 created（legacy = true）。
         需要 -Issue、-Topic；加 -Move 會在核對成功後刪除來源檔。舊封存沒有 manifest，不能當作 prune-bdd.ps1 的清理依據。

  封存庫根目錄：-ArchiveRoot；或 -Archive 所在目錄往上找 index.jsonl；或依 -Repo 的設定決定（同 archive-bdd.ps1）。
  -Import 不從來源路徑往上找，只看 -ArchiveRoot 或 -Repo。

.EXAMPLE
  pwsh -NoProfile -File bdd-archive-index.ps1 -Mark -Archive <zip> -Status uploaded-verified -Attachment 12345
  pwsh -NoProfile -File bdd-archive-index.ps1 -List -Repo . -Issue 5350
  pwsh -NoProfile -File bdd-archive-index.ps1 -Import -Archive .claude/bdd-archives/5350-12c76ee.zip -Repo . -Issue 5350 -Topic 5350-save-bar-layout -Commit 12c76ee -Move
#>
param(
    [switch]$List,
    [switch]$Mark,
    [switch]$Import,
    [switch]$Move,
    [string]$Commit,
    [string]$Archive,
    [ValidateSet('local-only', 'uploaded', 'uploaded-verified', 'superseded')][string]$Status,
    [string[]]$Attachment = @(),
    [string]$Note = '',
    [string]$ArchiveRoot,
    [string]$Repo,
    [string]$Issue,
    [string]$Topic
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('archive-index')
if ($List) { $cliArgs += '--list' }
if ($Mark) { $cliArgs += '--mark' }
if ($Import) { $cliArgs += '--import' }
if ($Move) { $cliArgs += '--move' }
foreach ($paramName in 'Archive', 'Repo', 'ArchiveRoot') {
    if ($PSBoundParameters[$paramName]) {
        $option = if ($paramName -eq 'ArchiveRoot') { 'archive-root' } else { $paramName.ToLowerInvariant() }
        $fullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PSBoundParameters[$paramName])
        $cliArgs += "--${option}=$fullPath"
    }
}
foreach ($paramName in 'Commit', 'Status', 'Note', 'Issue', 'Topic') {
    if ($PSBoundParameters.ContainsKey($paramName)) {
        $cliArgs += "--$($paramName.ToLowerInvariant())=$($PSBoundParameters[$paramName])"
    }
}
foreach ($item in $Attachment) { $cliArgs += "--attachment=$item" }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
