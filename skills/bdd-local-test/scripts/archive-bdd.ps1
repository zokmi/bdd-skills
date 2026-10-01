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
    [string]$Issue
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Add-Type -AssemblyName System.IO.Compression

$manifestName = 'bdd-manifest.json'
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
if (-not @(Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.feature').Count) { throw '缺少 .feature 情境檔，不能封存' }
if (Test-Path -LiteralPath (Join-Path $source $manifestName)) { throw "輸出目錄不可自帶 $manifestName（封存時會產生）" }

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
if ($unmasked.Count -and $maskConfig.required) {
    $list = ($unmasked | Select-Object -First 20) -join "`n  "
    throw ("有 $($unmasked.Count) 張圖片沒有有效的遮罩紀錄，不能封存（已解回的 evidence.zip 檔案保留在 evidence/）：`n  $list`n" +
        "請以 mask-evidence.ps1 -Apply 套用座標遮罩，或確認截圖時已遮罩後用 -Mark -Method css／exempt 登記；" +
        "專案確定不需遮罩時，在 .bdd/config.json 設定 mask.required = false。")
}

# 3. 蒐集與去重（舊 evidence.zip 已攤平，不再收入）
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force |
    Where-Object { -not ($_.FullName.Equals($legacyZip, [StringComparison]::OrdinalIgnoreCase)) } |
    ForEach-Object {
        [pscustomobject]@{
            relative = [IO.Path]::GetRelativePath($source, $_.FullName).Replace('\', '/')
            file = $_
            sha256 = Get-Sha256Hex -Path $_.FullName
        }
    } | Sort-Object relative -CaseSensitive)
$manifestFiles = [ordered]@{}
$aliases = [ordered]@{}
$canonicalBySha = @{}
foreach ($f in $files) {
    $manifestFiles[$f.relative] = [ordered]@{ sha256 = $f.sha256; size = $f.file.Length }
    if ($canonicalBySha.ContainsKey($f.sha256)) { $aliases[$f.relative] = $canonicalBySha[$f.sha256] }
    else { $canonicalBySha[$f.sha256] = $f.relative }
}
$stored = @($files | Where-Object { -not $aliases.Contains($_.relative) })

# 4. 受測版本與單號
if (-not $Commit) {
    $verification = Get-Content -LiteralPath (Join-Path $source 'verification.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $rounds = @(Get-ConfigValue $verification 'rounds' @())
    if (-not $rounds.Count -or -not (Get-ConfigValue $rounds[-1] 'head')) { throw 'verification.json 沒有任何輪次的 head，請以 -Commit 指定受測 SHA' }
    $Commit = $rounds[-1].head
}
$shortCommit = if ($Commit.Length -gt 7) { $Commit.Substring(0, 7) } else { $Commit }
if (-not $Issue -and $topic -match '^(\d+)-') { $Issue = $Matches[1] }

# 5. 決定封存位置並檢查不在任何 worktree 內
$root = Resolve-ArchiveRoot -BddDir $source -ArchiveRoot $ArchiveRoot
$warnings = @(Assert-OutsideRepoWorktrees -Target $root.path -RepoPath $source)
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$target = if ($Destination) { Get-NormalizedPath $Destination } else {
    $folder = if ($Issue) { $Issue } else { '_unnumbered' }
    Get-NormalizedPath (Join-Path $root.path "$folder/$topic-$shortCommit-$stamp.zip")
}
if ($Destination) { $warnings += @(Assert-OutsideRepoWorktrees -Target $target -RepoPath $source) }
if (Test-Path -LiteralPath $target) { throw "封存檔已存在，請使用新檔名，避免覆蓋：$target" }

$manifest = [ordered]@{
    schema = 1
    tool = 'bdd-local-test/archive-bdd.ps1'
    issue = $Issue
    topic = $topic
    commit = $Commit
    createdAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    masked = ($unmasked.Count -eq 0)
    maskRequired = $maskConfig.required
    unmasked = $unmasked
    flattenedFrom = if ($hasLegacyZip) { @('evidence.zip') } else { @() }
    sourceFileCount = $files.Count
    storedFileCount = $stored.Count
    files = $manifestFiles
    aliases = $aliases
}
$manifestJson = $manifest | ConvertTo-Json -Depth 6

# 6. 打包到暫存檔、驗證後再搬到正式位置
$parent = Split-Path -Path $target -Parent
[IO.Directory]::CreateDirectory($parent) | Out-Null
$temporary = Join-Path $parent ([IO.Path]::GetRandomFileName() + '.zip.tmp')
$prefix = "$topic/"
try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
    try {
        foreach ($f in $stored) {
            $level = if ($PrecompressedExtensions -contains $f.file.Extension.ToLowerInvariant()) { 'NoCompression' } else { 'Optimal' }
            $entry = $archive.CreateEntry($prefix + $f.relative, [IO.Compression.CompressionLevel]::$level)
            $entry.LastWriteTime = $f.file.LastWriteTime
            $out = $entry.Open(); $in = [IO.File]::OpenRead($f.file.FullName)
            try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
        }
        $entry = $archive.CreateEntry($prefix + $manifestName, [IO.Compression.CompressionLevel]::Optimal)
        $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
        try { $writer.Write($manifestJson) } finally { $writer.Dispose() }
    } finally { $archive.Dispose(); $stream.Dispose() }

    $archive = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        if ($entries.Count -ne $stored.Count + 1) { throw "封存檔案數不符：應有 $($stored.Count + 1)、ZIP $($entries.Count)" }
        foreach ($f in $stored) {
            $entry = $archive.GetEntry($prefix + $f.relative)
            if (-not $entry -or $entry.Length -ne $f.file.Length) { throw "封存缺少或大小不符：$($f.relative)" }
            $s = $entry.Open()
            try { $hash = Get-Sha256Hex -Stream $s } finally { $s.Dispose() }
            if ($hash -ne $f.sha256) { throw "封存內容不符：$($f.relative)" }
        }
        foreach ($alias in $aliases.Keys) {
            if ($manifestFiles[$alias].sha256 -ne $manifestFiles[$aliases[$alias]].sha256) { throw "去重對應錯誤：$alias" }
        }
    } finally { $archive.Dispose() }

    Move-Item -LiteralPath $temporary -Destination $target
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

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
if ($unmasked.Count) { $warnings += "有 $($unmasked.Count) 張圖片未登記遮罩（mask.required = false 才允許），上傳 issue 前請人工確認不含個資" }
if ($limit -and $size -gt $limit) { $warnings += "封存檔 $size 位元組超過附件上限 $limit，上傳 issue 前需拆分或只附最後一輪截圖" }

[pscustomobject]@{
    source = $source
    archive = $target
    archiveRoot = $root.path
    archiveRootSource = $root.source
    index = (Join-Path $root.path 'index.jsonl')
    commit = $Commit
    fileCount = $files.Count
    storedFileCount = $stored.Count
    aliasCount = $aliases.Count
    sourceBytes = [long](($files | ForEach-Object { $_.file.Length } | Measure-Object -Sum).Sum)
    sizeBytes = $size
    sha256 = $sha256
    masked = ($unmasked.Count -eq 0)
    flattened = $flattened
    superseded = @($previous | ForEach-Object { $_.archive })
    maxAttachmentBytes = $limit
    exceedsAttachmentLimit = [bool]($limit -and $size -gt $limit)
    warnings = $warnings
} | ConvertTo-Json -Depth 4
