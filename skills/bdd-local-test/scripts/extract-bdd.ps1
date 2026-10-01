<#
.SYNOPSIS
  解開 archive-bdd.ps1 產生的 BDD 封存，依 manifest 還原去重的檔案並逐檔驗證 SHA-256。

.DESCRIPTION
  ZIP 內第一層是輸出資料夾名稱（例如 5350-save-bar-layout/），解到 -To 底下後即為 <To>/<資料夾名>/。
  有 bdd-manifest.json 時（manifest 本身不解出，資料夾可直接再交給 archive-bdd.ps1）：把 aliases 指向的檔案複製回原本的檔名，並確認每個檔案的 SHA-256 與 manifest 相同。
  沒有 manifest（舊版封存）時：只做一般解壓。
  目標已有同名檔案時，內容相同就略過、不同就停止，不會覆蓋。

.PARAMETER Archive
  封存檔路徑。

.PARAMETER To
  解壓目的地目錄（例如 .bdd 目錄，解完會得到 .bdd/<資料夾名>/）。

.EXAMPLE
  pwsh -NoProfile -File extract-bdd.ps1 -Archive ~/bdd-archives/bsaila/5350/5350-save-bar-layout-12c76ee-20261001T160300.zip -To .bdd
#>
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$To
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Add-Type -AssemblyName System.IO.Compression

$archivePath = Get-NormalizedPath $Archive
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "封存檔不存在：$archivePath" }
$destination = Get-NormalizedPath $To
[IO.Directory]::CreateDirectory($destination) | Out-Null

$written = 0; $skipped = 0; $restored = 0
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    $manifestEntry = $entries | Where-Object { $_.FullName -match '^[^/]+/bdd-manifest\.json$' } | Select-Object -First 1
    $manifest = $null
    if ($manifestEntry) {
        $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    }

    foreach ($entry in $entries) {
        # manifest 只留在封存檔裡；解出來的資料夾要能直接再封存，不能自帶 manifest
        if ($manifestEntry -and $entry.FullName -eq $manifestEntry.FullName) { continue }
        $name = $entry.FullName.Replace('\', '/')
        if ($name -match '(^|/)\.\.(/|$)' -or $name -match '^[A-Za-z]:' -or $name.StartsWith('/')) { throw "封存含不安全的路徑：$name" }
        $target = Get-NormalizedPath (Join-Path $destination $name)
        if (-not (Test-PathUnder $target $destination)) { throw "封存項目解壓後會跑出目的地：$name" }
        $s = $entry.Open()
        try { $hash = Get-Sha256Hex -Stream $s } finally { $s.Dispose() }
        if (Test-Path -LiteralPath $target) {
            if ((Get-Sha256Hex -Path $target) -ne $hash) { throw "目的地已有同名但內容不同的檔案，不覆蓋：$target" }
            $skipped++; continue
        }
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        $written++
    }

    if ($manifest) {
        $folder = Join-Path $destination $manifest.topic
        foreach ($p in $manifest.aliases.PSObject.Properties) {
            $aliasPath = Get-NormalizedPath (Join-Path $folder $p.Name)
            $canonicalPath = Get-NormalizedPath (Join-Path $folder $p.Value)
            if (-not (Test-PathUnder $aliasPath $folder)) { throw "manifest 的 alias 路徑不安全：$($p.Name)" }
            if (Test-Path -LiteralPath $aliasPath) {
                if ((Get-Sha256Hex -Path $aliasPath) -ne (Get-Sha256Hex -Path $canonicalPath)) { throw "目的地已有同名但內容不同的檔案，不覆蓋：$aliasPath" }
                $skipped++; continue
            }
            [IO.Directory]::CreateDirectory((Split-Path $aliasPath -Parent)) | Out-Null
            Copy-Item -LiteralPath $canonicalPath -Destination $aliasPath
            (Get-Item -LiteralPath $aliasPath).LastWriteTime = (Get-Item -LiteralPath $canonicalPath).LastWriteTime
            $restored++
        }
        foreach ($p in $manifest.files.PSObject.Properties) {
            $path = Join-Path $folder $p.Name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "還原後缺少檔案：$($p.Name)" }
            if ((Get-Sha256Hex -Path $path) -ne $p.Value.sha256) { throw "還原後內容不符：$($p.Name)" }
        }
    }
} finally { $zip.Dispose() }

[pscustomobject]@{
    archive = $archivePath
    destination = $destination
    folder = if ($manifest) { (Join-Path $destination $manifest.topic) } else { $null }
    hasManifest = [bool]$manifest
    written = $written
    restoredAliases = $restored
    skippedIdentical = $skipped
    verifiedFiles = if ($manifest) { @($manifest.files.PSObject.Properties).Count } else { 0 }
} | ConvertTo-Json
