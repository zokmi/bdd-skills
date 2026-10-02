<#
.SYNOPSIS
  把既有的 BDD 封存（PNG 截圖）重新壓縮成無損 WebP 版，路徑與檔名不變，並在封存索引記錄 recompressed。

.DESCRIPTION
  流程：核對封存檔與索引的 SHA-256 → 解到暫存目錄並依 manifest 還原 aliases → 截圖轉無損 WebP（逐像素驗證）
  → 改寫封存內的遮罩紀錄與報告連結 → 去重、打包、逐檔驗證 → 以新檔取代舊檔 → 索引追加 recompressed。
  索引狀態（例如 uploaded-verified）不變；issue 上的附件仍是原本的 PNG 版，索引以 issueCopySha256 記錄那一版。
  沒有可轉的截圖時不改動檔案（changed = false）。需要支援 WebP 的 Python Pillow。
  舊版沒有 manifest 的封存也可處理，結果會補上 manifest（legacy = true）。
  取代舊檔的順序：舊檔改名 .bak → 新檔搬到原路徑 → 索引追加成功 → 才刪 .bak；任何一步失敗都會把 .bak 搬回原路徑。

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
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/BddImage.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/BddPack.psm1') -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archivePath = Get-NormalizedPath $Archive
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "封存檔不存在：$archivePath" }
$root = if ($ArchiveRoot) { Get-NormalizedPath $ArchiveRoot } else { Find-ArchiveIndexRoot $archivePath }
$state = Get-ArchiveStates $root | Where-Object { (Get-NormalizedPath $_.archive) -ieq $archivePath } | Select-Object -First 1
if (-not $state) { throw "索引裡沒有這個封存檔：$archivePath（索引：$root）" }
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actual -ne $state.sha256) { throw "封存檔 SHA-256 與索引記錄不同（記錄 $($state.sha256)、目前 $actual），拒絕重新壓縮" }
$encoder = Get-WebpEncoder
if (-not $encoder.kind) { throw '沒有可用的 WebP 編碼器（需要支援 WebP 的 Python Pillow），無法重新壓縮' }

# 預檢（殘留檔）要在建立暫存目錄之前，拒絕時才不會外洩 bdd-recompress-* 暫存目錄
$newZip = "$archivePath.recompress.zip"
$backup = "$archivePath.bak"
if (Test-Path -LiteralPath $newZip) { throw "上次重新壓縮留下的暫存檔仍在，請確認後刪除：$newZip" }
if (Test-Path -LiteralPath $backup) { throw "上次重新壓縮留下的備份仍在，請確認後處理：$backup" }

$staging = Join-Path ([IO.Path]::GetTempPath()) ('bdd-recompress-' + [IO.Path]::GetRandomFileName())
$sourceDir = Join-Path $staging 'src'
[IO.Directory]::CreateDirectory($sourceDir) | Out-Null

try {
    # 1. 解到暫存目錄（去掉第一層資料夾），並依 manifest 還原 aliases
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        $manifestEntry = $entries | Where-Object { $_.FullName -match '^[^/]+/bdd-manifest\.json$' } | Select-Object -First 1
        $manifest = $null
        if ($manifestEntry) {
            $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
            try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        }
        $firstSegments = @($entries | ForEach-Object { ($_.FullName -split '/', 2)[0] } | Sort-Object -Unique)
        $hasFolder = $firstSegments.Count -eq 1 -and $firstSegments[0] -notin @('evidence', 'features') -and @($entries | Where-Object { $_.FullName -notlike '*/*' }).Count -eq 0
        $prefix = if ($hasFolder) { "$($firstSegments[0])/" } else { '' }
        foreach ($entry in $entries) {
            if ($manifestEntry -and $entry.FullName -eq $manifestEntry.FullName) { continue }
            $relative = $entry.FullName.Substring($prefix.Length)
            if ($relative -match '(^|/)\.\.(/|$)' -or $relative -match '^[A-Za-z]:' -or $relative.StartsWith('/')) { throw "封存含不安全的路徑：$($entry.FullName)" }
            $target = Get-NormalizedPath (Join-Path $sourceDir $relative)
            if (-not (Test-PathUnder $target $sourceDir)) { throw "封存項目解壓後會跑出暫存目錄：$($entry.FullName)" }
            [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        }
    } finally { $zip.Dispose() }
    if ($manifest -and $manifest.PSObject.Properties['aliases'] -and $manifest.aliases) {
        foreach ($p in $manifest.aliases.PSObject.Properties) {
            $aliasPath = Get-NormalizedPath (Join-Path $sourceDir $p.Name)
            if (-not (Test-PathUnder $aliasPath $sourceDir)) { throw "manifest 的 alias 路徑不安全：$($p.Name)" }
            [IO.Directory]::CreateDirectory((Split-Path $aliasPath -Parent)) | Out-Null
            Copy-Item -LiteralPath (Join-Path $sourceDir $p.Value) -Destination $aliasPath
        }
    }

    # 2. 建立封存項目，保留舊 manifest 每個檔案的附加欄位（例如 scenarioPath、originalName）
    $packEntries = @(Get-ChildItem -LiteralPath $sourceDir -Recurse -File | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($sourceDir, $_.FullName).Replace('\', '/')
        $extra = [ordered]@{}
        if ($manifest -and $manifest.PSObject.Properties['files'] -and $manifest.files.PSObject.Properties[$relative]) {
            foreach ($prop in $manifest.files.$relative.PSObject.Properties) {
                if ($prop.Name -notin 'sha256', 'size') { $extra[$prop.Name] = $prop.Value }
            }
        }
        New-PackEntry -Relative $relative -Path $_.FullName -Extra $extra
    })

    # 3. 轉檔；沒有任何截圖轉成功就不改動
    $webp = Convert-PackEntriesToWebp -Entries $packEntries -Encoder $encoder -Staging $staging
    if (-not @($webp.converted).Count) {
        [pscustomobject]@{ archive = $archivePath; changed = $false; previousBytes = $state.bytes; bytes = $state.bytes; savedBytes = 0
            converted = 0; skipped = @($webp.skipped); sha256 = $actual } | ConvertTo-Json -Depth 4
        return
    }
    $packEntries = Update-PackMaskLedger -Entries $webp.entries -Converted $webp.converted -Staging $staging
    $links = Update-PackMarkdownLinks -Entries $packEntries -Converted $webp.converted -Staging $staging
    $plan = Get-DedupPlan $links.entries
    $saved = [long](($webp.converted | ForEach-Object { $_.sourceBytes - $_.webpBytes } | Measure-Object -Sum).Sum)

    # 4. 新 manifest：沿用舊欄位，覆寫檔案清單與轉檔資訊；舊版封存補上基本欄位
    $newManifest = [ordered]@{}
    if ($manifest) { foreach ($prop in $manifest.PSObject.Properties) { $newManifest[$prop.Name] = $prop.Value } }
    else {
        $newManifest.tool = 'bdd-local-test/recompress-bdd.ps1'
        $newManifest.legacy = $true
        $newManifest.issue = $state.issue
        $newManifest.topic = $state.topic
        $newManifest.commit = $state.commit
        $newManifest.masked = $false
        $newManifest.unmaskedReason = '舊版封存，未經遮罩登記檢查'
    }
    $newManifest.schema = 2
    $newManifest.storedFileCount = $plan.stored.Count
    $newManifest.files = $plan.files
    $newManifest.aliases = $plan.aliases
    $newManifest.webp = [ordered]@{ encoder = $encoder.kind; converted = @($webp.converted).Count; skipped = @($webp.skipped); savedBytes = $saved }
    $newManifest.rewrittenLinks = $links.rewritten
    $newManifest.recompressedFrom = [ordered]@{ sha256 = $actual; bytes = $state.bytes; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
    $outPrefix = if ($prefix) { $prefix } else { "$($state.topic)/" }

    # 5. 寫新檔、驗證，再取代舊檔；取代或寫索引任一步失敗都把舊檔搬回原路徑
    Write-BddZip -Stored $plan.stored -Prefix $outPrefix -ManifestJson ($newManifest | ConvertTo-Json -Depth 8) -Target $newZip
    Move-Item -LiteralPath $archivePath -Destination $backup
    try {
        Move-Item -LiteralPath $newZip -Destination $archivePath
        $sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
        $bytes = (Get-Item -LiteralPath $archivePath).Length
        Add-ArchiveIndexEvent $root ([ordered]@{
            event = 'recompressed'; archive = $state.archive; previousSha256 = $actual; previousBytes = $state.bytes
            sha256 = $sha256; bytes = $bytes; encoder = $encoder.kind; converted = @($webp.converted).Count
            at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        })
    } catch {
        if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
        Move-Item -LiteralPath $backup -Destination $archivePath
        throw
    }
    Remove-Item -LiteralPath $backup -Force

    [pscustomobject]@{
        archive = $archivePath; changed = $true; previousBytes = $state.bytes; bytes = $bytes; savedBytes = [long]$state.bytes - $bytes
        converted = @($webp.converted).Count; skipped = @($webp.skipped); sha256 = $sha256
    } | ConvertTo-Json -Depth 4
} finally {
    if (Test-Path -LiteralPath $newZip) { Remove-Item -LiteralPath $newZip -Force }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
