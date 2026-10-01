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
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force

if (@($List, $Mark, $Import | Where-Object { $_ }).Count -ne 1) { throw '請擇一指定 -List、-Mark 或 -Import' }

# 決定封存庫根目錄
function Find-IndexRoot {
    if ($ArchiveRoot) { return Get-NormalizedPath $ArchiveRoot }
    if ($Archive -and -not $Import) {
        $dir = Split-Path (Get-NormalizedPath $Archive) -Parent
        for ($i = 0; $i -lt 4 -and $dir; $i++) {
            if (Test-Path -LiteralPath (Join-Path $dir 'index.jsonl')) { return $dir }
            $dir = Split-Path $dir -Parent
        }
    }
    if ($Repo) {
        # Resolve-ArchiveRoot 以「輸出目錄的上一層」找 .bdd/config.json，所以傳入 <repo>/.bdd/ 底下的虛擬子目錄
        $top = Get-RepoTopLevel (Get-NormalizedPath $Repo)
        return (Resolve-ArchiveRoot -BddDir (Join-Path $top '.bdd/_')).path
    }
    throw '找不到封存索引，請指定 -ArchiveRoot、-Archive 或 -Repo'
}

$root = Find-IndexRoot
$states = @(Get-ArchiveStates $root)

if ($List) {
    $result = @($states | Where-Object { (-not $Issue -or $_.issue -eq $Issue) -and (-not $Topic -or $_.topic -eq $Topic) } |
        ForEach-Object { $_ | Add-Member -NotePropertyName exists -NotePropertyValue (Test-Path -LiteralPath $_.archive) -PassThru })
    [pscustomobject]@{ archiveRoot = $root; count = $result.Count; archives = $result } | ConvertTo-Json -Depth 5
    return
}

if ($Import) {
    if (-not $Archive -or -not $Issue -or -not $Topic) { throw '-Import 需要 -Archive、-Issue 與 -Topic' }
    $sourcePath = Get-NormalizedPath $Archive
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "來源封存檔不存在：$sourcePath" }
    $warnings = @()
    $repoId = $null
    if ($Repo) {
        $warnings += @(Assert-OutsideRepoWorktrees -Target $root -RepoPath (Get-NormalizedPath $Repo))
        $repoId = @(Get-RepoWorktrees (Get-NormalizedPath $Repo))[0]
    }
    $target = Get-NormalizedPath (Join-Path $root "$Issue/legacy/$(Split-Path $sourcePath -Leaf)")
    if (Test-PathUnder $sourcePath $root) { throw "來源已在封存庫內，不需要匯入：$sourcePath" }
    $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    if (@($states | Where-Object { (Get-NormalizedPath $_.archive) -ieq $target }).Count) { throw "索引已有這個封存檔：$target" }
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash) { throw "封存庫已有同名但內容不同的檔案：$target" }
    } else {
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $target
    }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash) { throw "複製後 SHA-256 不符，保留來源：$sourcePath" }
    $now = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    Add-ArchiveIndexEvent $root ([ordered]@{
        event = 'created'; archive = $target; name = (Split-Path $target -Leaf); issue = $Issue; topic = $Topic
        commit = $Commit; sha256 = $sourceHash; bytes = (Get-Item -LiteralPath $target).Length; repo = $repoId
        sourceDir = $null; legacy = $true; importedFrom = $sourcePath; note = $Note; at = $now
    })
    if ($Move) { Remove-Item -LiteralPath $sourcePath -Force }
    [pscustomobject]@{ archiveRoot = $root; archive = $target; sha256 = $sourceHash; movedSource = [bool]$Move; warnings = $warnings } | ConvertTo-Json -Depth 3
    return
}

if (-not $Archive -or -not $Status) { throw '-Mark 需要 -Archive 與 -Status' }
$archivePath = Get-NormalizedPath $Archive
$state = $states | Where-Object { (Get-NormalizedPath $_.archive) -ieq $archivePath } | Select-Object -First 1
if (-not $state) { throw "索引裡沒有這個封存檔：$archivePath（索引：$root）" }
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "封存檔不存在：$archivePath" }
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actual -ne $state.sha256) { throw "封存檔 SHA-256 與建立時不同（建立 $($state.sha256)、目前 $actual），拒絕登記" }
$attachments = @($Attachment | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Status -in @('uploaded', 'uploaded-verified') -and -not $attachments.Count) { throw "$Status 必須以 -Attachment 指定 issue 附件 ID 或網址" }

$event = [ordered]@{ event = 'status'; archive = $state.archive; status = $Status; attachments = $attachments; note = $Note; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
Add-ArchiveIndexEvent $root $event
[pscustomobject]@{ archiveRoot = $root; archive = $state.archive; previousStatus = $state.status; status = $Status; attachments = $attachments; sha256 = $actual } | ConvertTo-Json -Depth 4
