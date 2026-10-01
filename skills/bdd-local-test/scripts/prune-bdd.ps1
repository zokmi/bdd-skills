<#
.SYNOPSIS
  清理工作區裡已安全封存的 BDD 證據（evidence/ 與舊的 evidence.zip），預設只列出計畫不刪除。

.DESCRIPTION
  對 <Repo>/.bdd/ 底下每個輸出資料夾：
    1. 從封存索引找出同主題、目前狀態為 uploaded-verified、檔案仍存在且 SHA-256 與建立時相同的封存檔。
    2. 讀出這些封存檔 manifest 記錄的所有內容雜湊。
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
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Add-Type -AssemblyName System.IO.Compression

$top = Get-RepoTopLevel (Get-NormalizedPath $Repo)
$bddRoot = Join-Path $top '.bdd'
if (-not (Test-Path -LiteralPath $bddRoot -PathType Container)) {
    [pscustomobject]@{ repo = $top; applied = [bool]$Apply; items = @() } | ConvertTo-Json; return
}
# Resolve-ArchiveRoot 以「輸出目錄的上一層」找 .bdd/config.json，所以傳入 .bdd/ 底下的虛擬子目錄
$root = (Resolve-ArchiveRoot -BddDir (Join-Path $bddRoot '_') -ArchiveRoot $ArchiveRoot).path
$states = @(Get-ArchiveStates $root)

# 讀出封存檔 manifest 的所有內容雜湊；讀不到 manifest（舊版封存）回傳 $null
function Get-ManifestHashes([string]$Path) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -match '^[^/]+/bdd-manifest\.json$' } | Select-Object -First 1
        if (-not $entry) { return $null }
        $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        @($manifest.files.PSObject.Properties | ForEach-Object { $_.Value.sha256 })
    } finally { $zip.Dispose() }
}

$items = foreach ($dir in Get-ChildItem -LiteralPath $bddRoot -Directory -Force) {
    $evidenceDir = Join-Path $dir.FullName 'evidence'
    $legacyZip = Join-Path $dir.FullName 'evidence.zip'
    $hasDir = Test-Path -LiteralPath $evidenceDir -PathType Container
    $hasZip = Test-Path -LiteralPath $legacyZip -PathType Leaf
    if (-not $hasDir -and -not $hasZip) { continue }

    $item = [ordered]@{ topic = $dir.Name; path = $dir.FullName; bytes = 0L; action = 'keep'; reason = ''; coveredBy = @() }
    if ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint -or
        @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        $item.reason = '含符號連結或 junction，不自動清理'; [pscustomobject]$item; continue
    }

    $hashes = [Collections.Generic.List[string]]::new()
    if ($hasDir) {
        foreach ($f in Get-ChildItem -LiteralPath $evidenceDir -Recurse -File -Force) { $hashes.Add((Get-Sha256Hex -Path $f.FullName)); $item.bytes += $f.Length }
    }
    if ($hasZip) {
        $item.bytes += (Get-Item -LiteralPath $legacyZip).Length
        $zip = [IO.Compression.ZipFile]::OpenRead($legacyZip)
        try {
            foreach ($e in $zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') }) {
                $s = $e.Open(); try { $hashes.Add((Get-Sha256Hex -Stream $s)) } finally { $s.Dispose() }
            }
        } finally { $zip.Dispose() }
    }

    $accepted = if ($AllowLocalOnly) { @('uploaded-verified', 'uploaded', 'local-only') } else { @('uploaded-verified') }
    $candidates = @($states | Where-Object { $_.topic -eq $dir.Name -and $_.status -in $accepted })
    if (-not $candidates.Count) { $item.reason = "沒有狀態為 $($accepted -join '／') 的同主題封存"; [pscustomobject]$item; continue }
    $known = [Collections.Generic.HashSet[string]]::new()
    foreach ($c in $candidates) {
        if (-not (Test-Path -LiteralPath $c.archive -PathType Leaf)) { continue }
        if ((Get-FileHash -LiteralPath $c.archive -Algorithm SHA256).Hash -ne $c.sha256) { continue }
        $manifestHashes = Get-ManifestHashes $c.archive
        if ($null -eq $manifestHashes) { continue }
        foreach ($h in $manifestHashes) { $null = $known.Add($h) }
        $item.coveredBy += $c.archive
    }
    if (-not $item.coveredBy.Count) { $item.reason = '同主題封存檔不存在、SHA-256 不符或沒有 manifest'; [pscustomobject]$item; continue }
    $missing = @($hashes | Where-Object { -not $known.Contains($_) })
    if ($missing.Count) { $item.reason = "有 $($missing.Count) 個證據檔的內容不在已上傳的封存裡"; [pscustomobject]$item; continue }

    $item.action = 'prune'
    $item.reason = if ($AllowLocalOnly) { '證據內容全部收在本機封存庫的封存中' } else { '證據內容全部收在已上傳並確認的封存中' }
    if ($Apply) {
        foreach ($p in @($evidenceDir, $legacyZip)) {
            if (-not (Test-Path -LiteralPath $p)) { continue }
            if (-not (Test-PathUnder $p $dir.FullName) -or -not (Test-PathUnder $p $bddRoot)) { throw "路徑檢查失敗，停止清理：$p" }
            Remove-Item -LiteralPath $p -Recurse -Force
        }
        $item.action = 'pruned'
    }
    [pscustomobject]$item
}

$items = @($items)
[pscustomobject]@{
    repo = $top
    archiveRoot = $root
    applied = [bool]$Apply
    prunableBytes = [long](($items | Where-Object { $_.action -in 'prune', 'pruned' } | ForEach-Object { $_.bytes } | Measure-Object -Sum).Sum)
    items = $items
} | ConvertTo-Json -Depth 4
