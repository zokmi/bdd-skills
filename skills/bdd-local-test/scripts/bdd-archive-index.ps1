<#
.SYNOPSIS
  查詢或更新本機 BDD 封存索引（index.jsonl）。

.DESCRIPTION
  -List：列出每個封存檔目前的狀態（可用 -Issue／-Topic 篩選）。
  -Mark：登記某個封存檔的新狀態，例如上傳 issue 並確認可下載後標為 uploaded-verified。
         登記前會重新計算封存檔 SHA-256，與建立時的紀錄不同就拒絕（避免登記到被改過或壞掉的檔案）。
         uploaded／uploaded-verified 必須帶 -Attachment（附件 ID 或網址），prune-bdd.ps1 只認 uploaded-verified。

  封存庫根目錄：-ArchiveRoot；或 -Archive 所在目錄往上找 index.jsonl；或依 -Repo 的設定決定（同 archive-bdd.ps1）。

.EXAMPLE
  pwsh -NoProfile -File bdd-archive-index.ps1 -Mark -Archive <zip> -Status uploaded-verified -Attachment 12345
  pwsh -NoProfile -File bdd-archive-index.ps1 -List -Repo . -Issue 5350
#>
param(
    [switch]$List,
    [switch]$Mark,
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

if ($List -eq $Mark) { throw '請擇一指定 -List 或 -Mark' }

# 決定封存庫根目錄
function Find-IndexRoot {
    if ($ArchiveRoot) { return Get-NormalizedPath $ArchiveRoot }
    if ($Archive) {
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
