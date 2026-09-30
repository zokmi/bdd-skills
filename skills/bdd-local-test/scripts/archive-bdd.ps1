<#
.SYNOPSIS
  將最終 BDD 輸出封存到受測 worktree 之外，逐檔驗證 ZIP 內容並回傳摘要。

.EXAMPLE
  pwsh -NoProfile -File archive-bdd.ps1 -Dir .bdd/94542-topic -Destination ../bdd-archives/94542-abc1234.zip
#>
param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression

$source = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "BDD 輸出目錄不存在：$source" }
$repoRoot = (git -C $source rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw 'BDD 輸出目錄必須位於 git 工作區內' }
$repoRoot = [IO.Path]::GetFullPath($repoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$target = [IO.Path]::GetFullPath($Destination)
$compare = [StringComparison]::OrdinalIgnoreCase
if ($target.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, $compare) -or $target.Equals($repoRoot, $compare)) {
    throw '封存檔必須位於受測 worktree 之外，否則刪除 worktree 會連封存檔一起移除'
}
if (Test-Path -LiteralPath $target) { throw "封存檔已存在，請使用新檔名，避免覆蓋：$target" }

foreach ($required in @('REPORT.md', 'verification.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw "缺少 $required，不能封存" }
}
if (Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
    throw 'BDD 輸出含符號連結或 junction；請先確認來源，避免封存 worktree 外的資料'
}
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force)
if (-not @($files | Where-Object { $_.Extension -eq '.feature' }).Count) { throw '缺少 .feature 情境檔，不能封存' }
if (-not @($files | Where-Object { $_.FullName -match '[\\/]evidence[\\/]' -or $_.Name -eq 'evidence.zip' }).Count) {
    throw '缺少截圖／其他證據檔，不能封存'
}

$parent = Split-Path -Path $target -Parent
[IO.Directory]::CreateDirectory($parent) | Out-Null
$temporary = Join-Path $parent ([IO.Path]::GetRandomFileName() + '.zip')
$archive = $null
try {
    [IO.Compression.ZipFile]::CreateFromDirectory($source, $temporary, [IO.Compression.CompressionLevel]::Optimal, $true)
    $archive = [IO.Compression.ZipFile]::OpenRead($temporary)
    $prefix = [IO.Path]::GetFileName($source) + '/'
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    if ($entries.Count -ne $files.Count) { throw "封存檔案數不符：來源 $($files.Count)、ZIP $($entries.Count)" }

    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($source, $file.FullName).Replace('\', '/')
        $entry = $archive.GetEntry($prefix + $relative)
        if (-not $entry -or $entry.Length -ne $file.Length) { throw "封存缺少或大小不符：$relative" }
        $sourceStream = [IO.File]::OpenRead($file.FullName)
        $entryStream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $sourceHash = [Convert]::ToHexString($sha.ComputeHash($sourceStream))
            $entryHash = [Convert]::ToHexString($sha.ComputeHash($entryStream))
            if ($sourceHash -ne $entryHash) { throw "封存內容不符：$relative" }
        } finally {
            $sha.Dispose()
            $entryStream.Dispose()
            $sourceStream.Dispose()
        }
    }
    $archive.Dispose(); $archive = $null
    Move-Item -LiteralPath $temporary -Destination $target
    [pscustomobject]@{
        source = $source
        archive = $target
        fileCount = $files.Count
        sizeBytes = (Get-Item -LiteralPath $target).Length
        sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
    } | ConvertTo-Json -Depth 3
} finally {
    if ($archive) { $archive.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
