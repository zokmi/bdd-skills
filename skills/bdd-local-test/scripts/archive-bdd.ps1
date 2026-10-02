<#
.SYNOPSIS
  將最終 BDD 輸出封存到本機封存庫（受測 repo 所有 worktree 之外），去重、驗證並登記到封存索引。

.DESCRIPTION
  流程：攤平舊 evidence.zip → 檢查圖片都已遮罩 → 依內容去重 → 打包並寫入 bdd-manifest.json
  → 逐檔驗證 SHA-256 → 搬到封存庫 → 在 index.jsonl 追加 created 事件，並把同主題的舊封存標為 superseded。

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
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/BddPack.psm1') -Force
Add-Type -AssemblyName System.IO.Compression

$source = Get-NormalizedPath $Dir
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "BDD 輸出目錄不存在：$source" }
$repoRoot = Get-RepoTopLevel $source
$worktrees = @(Get-RepoWorktrees $source)
$topic = Split-Path $source -Leaf

foreach ($required in @('REPORT.md', 'verification.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw "缺少 $required，不能封存" }
}
if (Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
    throw 'BDD 輸出含符號連結或 junction；請先確認來源，避免封存 worktree 外的資料'
}
# 讀取最後一輪驗證紀錄：受測版本與本輪執行的模組情境
$verification = Get-Content -LiteralPath (Join-Path $source 'verification.json') -Raw -Encoding utf8 | ConvertFrom-Json
$rounds = @(Get-ConfigValue $verification 'rounds' @())
$lastRound = if ($rounds.Count) { $rounds[-1] } else { $null }
$scenarios = @(Get-ConfigValue $lastRound 'scenarios' @())
$hasIssueFeature = [bool]@(Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.feature').Count
if (-not $hasIssueFeature -and -not $scenarios.Count) { throw '缺少情境：輸出資料夾沒有 .feature，verification.json 最後一輪也沒有 scenarios，不能封存' }
if (Test-Path -LiteralPath (Join-Path $source $ManifestName)) { throw "輸出目錄不可自帶 $ManifestName（封存時會產生）" }

# 1. 攤平：舊輪次的 evidence.zip 解回 evidence/，同名同內容略過、同名不同內容停止
$flattened = @()
$legacyZip = Join-Path $source 'evidence.zip'
$hasLegacyZip = Test-Path -LiteralPath $legacyZip -PathType Leaf
if ($hasLegacyZip) {
    $zip = [IO.Compression.ZipFile]::OpenRead($legacyZip)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $relative = ConvertTo-EvidenceEntryPath $entry.FullName
            $target = Get-NormalizedPath (Join-Path $source $relative)
            if (-not (Test-PathUnder $target $source)) { throw "evidence.zip 項目解壓後會跑出輸出目錄：$($entry.FullName)" }
            $stream = $entry.Open()
            try { $entryHash = Get-Sha256Hex -Stream $stream } finally { $stream.Dispose() }
            if (Test-Path -LiteralPath $target) {
                if ((Get-Sha256Hex -Path $target) -ne $entryHash) {
                    throw "evidence.zip 與 evidence/ 有同名但內容不同的檔案，請人工確認後再封存：$relative"
                }
                continue
            }
            [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
            $flattened += $relative
        }
    } finally { $zip.Dispose() }
}

$evidence = @(Get-EvidenceFiles $source)
if (-not $evidence.Count) { throw '缺少截圖／其他證據檔（evidence/ 為空），不能封存' }

# 2. 遮罩檢查：每張圖片都要在 masking.json 有紀錄，且紀錄的 SHA-256 與目前檔案相同
$config = Get-BddConfig $source
$maskConfig = Get-MaskConfig $config.data
$ledger = Read-MaskLedger $source
$unmasked = @(foreach ($e in $evidence) {
    if (-not (Test-ImageFile $e.relative)) { continue }
    $record = $ledger[$e.relative]
    if (-not $record -or $record.sha256 -ne (Get-Sha256Hex -Path $e.file.FullName)) { $e.relative }
})
if ($PSBoundParameters.ContainsKey('AllowUnmaskedReason') -and -not "$AllowUnmaskedReason".Trim()) {
    throw '-AllowUnmaskedReason 必須寫明理由'
}
if ($unmasked.Count -and $maskConfig.required -and -not $AllowUnmaskedReason) {
    $list = ($unmasked | Select-Object -First 20) -join "`n  "
    throw ("有 $($unmasked.Count) 張圖片沒有有效的遮罩紀錄，不能封存（已解回的 evidence.zip 檔案保留在 evidence/）：`n  $list`n" +
        "請以 mask-evidence.ps1 -Apply 套用座標遮罩，或確認截圖時已遮罩後用 -Mark -Method css／exempt 登記；" +
        "專案確定不需遮罩時，在 .bdd/config.json 設定 mask.required = false。")
}

# 4. 受測版本與單號（情境快照需要受測 commit，所以放在蒐集之前）
if (-not $Commit) {
    if (-not $lastRound -or -not (Get-ConfigValue $lastRound 'head')) { throw 'verification.json 沒有任何輪次的 head，請以 -Commit 指定受測 SHA' }
    $Commit = $lastRound.head
}
$shortCommit = if ($Commit.Length -gt 7) { $Commit.Substring(0, 7) } else { $Commit }
if (-not $Issue -and $topic -match '^(\d+)-') { $Issue = $Matches[1] }

# 3. 蒐集（舊 evidence.zip 已攤平，不再收入）
$entries = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force |
    Where-Object { -not ($_.FullName.Equals($legacyZip, [StringComparison]::OrdinalIgnoreCase)) } |
    ForEach-Object { New-PackEntry -Relative ([IO.Path]::GetRelativePath($source, $_.FullName)) -Path $_.FullName })
$sourceFileCount = $entries.Count

$staging = Join-Path ([IO.Path]::GetTempPath()) ('bdd-archive-' + [IO.Path]::GetRandomFileName())
[IO.Directory]::CreateDirectory($staging) | Out-Null
try {
# 3-1. 模組情境快照：取受測 commit 當時的版本；輸出資料夾已有同路徑同內容（例如從封存還原）就不重複收
$existing = @{}
foreach ($e in $entries) { $existing[$e.relative] = $e }
foreach ($snap in @(Get-ScenarioSnapshotEntries -RepoRoot $repoRoot -Commit $Commit -Scenarios $scenarios -Staging $staging)) {
    if ($existing.ContainsKey($snap.relative)) {
        if ($existing[$snap.relative].sha256 -ne $snap.sha256) { throw "輸出資料夾已有 $($snap.relative)，但內容與受測 commit 的情境不同，請人工確認" }
        continue
    }
    $entries += $snap
}

# 5. 決定封存位置並檢查不在任何 worktree 內
$root = Resolve-ArchiveRoot -BddDir $source -ArchiveRoot $ArchiveRoot
$warnings = @(Assert-OutsideRepoWorktrees -Target $root.path -RepoPath $source)
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$target = if ($Destination) { Get-NormalizedPath $Destination } else {
    $folder = if ($Issue) { $Issue } else { '_unnumbered' }
    Get-NormalizedPath (Join-Path $root.path "$folder/$topic-$shortCommit-$stamp.zip")
}
if ($Destination) { $warnings += @(Assert-OutsideRepoWorktrees -Target $target -RepoPath $source) }
$plan = Get-DedupPlan $entries

$manifest = [ordered]@{
    schema = 1
    tool = 'bdd-local-test/archive-bdd.ps1'
    issue = $Issue
    topic = $topic
    commit = $Commit
    features = @($scenarios | ForEach-Object { $_.path })
    createdAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    masked = ($unmasked.Count -eq 0)
    maskRequired = $maskConfig.required
    unmasked = $unmasked
    unmaskedReason = if ($unmasked.Count) { $AllowUnmaskedReason } else { $null }
    flattenedFrom = if ($hasLegacyZip) { @('evidence.zip') } else { @() }
    sourceFileCount = $sourceFileCount
    storedFileCount = $plan.stored.Count
    files = $plan.files
    aliases = $plan.aliases
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6

# 6. 打包、驗證後才搬到正式位置（失敗不留半成品）
Write-BddZip -Stored $plan.stored -Prefix "$topic/" -ManifestJson $manifestJson -Target $target

# 7. 登記索引：新增 created，同 repo 同主題且尚未被取代的舊封存標為 superseded
$sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
$size = (Get-Item -LiteralPath $target).Length
$repoId = if ($worktrees.Count) { $worktrees[0] } else { $repoRoot }
$now = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$previous = @(Get-ArchiveStates $root.path | Where-Object { $_.topic -eq $topic -and $_.repo -eq $repoId -and $_.status -ne 'superseded' })
Add-ArchiveIndexEvent $root.path ([ordered]@{
    event = 'created'; archive = $target; name = (Split-Path $target -Leaf); issue = $Issue; topic = $topic
    commit = $Commit; sha256 = $sha256; bytes = $size; repo = $repoId; sourceDir = $source; at = $now
})
foreach ($p in $previous) {
    Add-ArchiveIndexEvent $root.path ([ordered]@{ event = 'status'; archive = $p.archive; status = 'superseded'; by = $target; at = $now })
}

$limit = Get-ConfigValue $config.data 'maxAttachmentBytes'
if ($unmasked.Count) { $warnings += "有 $($unmasked.Count) 張圖片未登記遮罩，此封存不可上傳 issue；需要上傳時先遮罩再重新封存" }
if ($limit -and $size -gt $limit) { $warnings += "封存檔 $size 位元組超過附件上限 $limit，上傳 issue 前需拆分或只附最後一輪截圖" }

[pscustomobject]@{
    source = $source
    archive = $target
    archiveRoot = $root.path
    archiveRootSource = $root.source
    index = (Join-Path $root.path 'index.jsonl')
    commit = $Commit
    fileCount = $sourceFileCount
    storedFileCount = $plan.stored.Count
    aliasCount = $plan.aliases.Count
    sourceBytes = [long](($entries | ForEach-Object { $_.size } | Measure-Object -Sum).Sum)
    sizeBytes = $size
    sha256 = $sha256
    masked = ($unmasked.Count -eq 0)
    flattened = $flattened
    superseded = @($previous | ForEach-Object { $_.archive })
    maxAttachmentBytes = $limit
    exceedsAttachmentLimit = [bool]($limit -and $size -gt $limit)
    warnings = $warnings
} | ConvertTo-Json -Depth 4
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
