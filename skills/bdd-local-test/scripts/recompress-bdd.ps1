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
Import-Module (Join-Path $PSScriptRoot 'lib/BddExtract.psm1') -Force

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
    # 1. 使用共用還原流程驗證路徑及 SHA-256，並從 ZIP 內還原 aliases。
    $extracted = Expand-BddArchive -Archive $archivePath -To $sourceDir
    $manifest = $extracted.manifest
    $topic = $state.topic
    $rootItems = @(Get-ChildItem -LiteralPath $sourceDir -Force)
    if ($manifest) {
        if ($rootItems.Count -gt 1 -or ($rootItems.Count -eq 1 -and $rootItems[0].FullName -ne $extracted.folder)) {
            throw '封存含有 manifest topic 以外的檔案'
        }
        $sourceDir = $extracted.folder
        $topic = [IO.Path]::GetFileName($sourceDir)
    } elseif ($rootItems.Count -eq 1 -and $rootItems[0].PSIsContainer -and $rootItems[0].Name -notin @('evidence', 'features')) {
        # 舊 ZIP 可能有一層資料夾，也可能直接從 evidence/、features/ 或報告開始。
        $topic = $rootItems[0].Name
        $sourceDir = $rootItems[0].FullName
    }

    # 2. 沿用解壓時算出的 SHA-256 和舊 manifest 的附加欄位。
    $packEntries = @(foreach ($path in $extracted.hashes.Keys) {
        $relative = [IO.Path]::GetRelativePath($sourceDir, $path).Replace('\', '/')
        $extra = [ordered]@{}
        if ($manifest.files -and $manifest.files[$relative]) {
            foreach ($key in $manifest.files[$relative].get_Keys()) {
                if ($key -notin 'sha256', 'size') { $extra[$key] = $manifest.files[$relative][$key] }
            }
        }
        New-PackEntry -Relative $relative -Path $path -Extra $extra -Sha256 $extracted.hashes[$path]
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
    if ($manifest) { foreach ($key in $manifest.get_Keys()) { $newManifest[$key] = $manifest[$key] } }
    else {
        $newManifest.tool = 'bdd-local-test/recompress-bdd.ps1'
        $newManifest.legacy = $true
        $newManifest.issue = $state.issue
        $newManifest.commit = $state.commit
        $newManifest.masked = $false
        $newManifest.unmaskedReason = '舊版封存，未經遮罩登記檢查'
    }
    $newManifest.topic = $topic
    $newManifest.schema = 2
    $newManifest.storedFileCount = $plan.stored.Count
    $newManifest.files = $plan.files
    $newManifest.aliases = $plan.aliases
    $newManifest.webp = [ordered]@{ encoder = $encoder.kind; converted = @($webp.converted).Count; skipped = @($webp.skipped); savedBytes = $saved }
    $newManifest.rewrittenLinks = $links.rewritten
    $newManifest.recompressedFrom = [ordered]@{ sha256 = $actual; bytes = $state.bytes; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
    $outPrefix = "$topic/"

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
