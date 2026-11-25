<#
.SYNOPSIS
  封存測試使用的 PowerShell 工具，建立封存項目、轉換圖片、依內容去重及驗證 ZIP。
#>

Set-StrictMode -Version 3.0
Import-Module (Join-Path $PSScriptRoot 'BddArchive.psm1')
Import-Module (Join-Path $PSScriptRoot 'BddImage.psm1')
Add-Type -AssemblyName System.IO.Compression

<#
.SYNOPSIS
  封存內 manifest 的檔名。
#>
$script:ManifestName = 'bdd-manifest.json'

<#
.SYNOPSIS
  建立一個封存項目：relative（封存內相對路徑，以 / 分隔）、path（實體檔）、sha256、size、lastWrite、extra（寫進 manifest 的附加欄位）。
#>
function New-PackEntry {
    param(
        [Parameter(Mandatory)][string]$Relative,
        [Parameter(Mandatory)][string]$Path,
        $Extra = $null,
        [string]$Sha256
    )
    $item = Get-Item -LiteralPath $Path
    $copy = [ordered]@{}
    if ($Extra) { foreach ($k in $Extra.Keys) { $copy[$k] = $Extra[$k] } }
    [pscustomobject]@{
        relative = $Relative.Replace('\', '/')
        path = $item.FullName
        sha256 = if ($Sha256) { $Sha256 } else { Get-Sha256Hex -Path $item.FullName }
        size = $item.Length
        lastWrite = $item.LastWriteTime
        extra = $copy
    }
}

function Test-PackEntryWebpCandidate($Entry) {
    $Entry.relative.StartsWith('evidence/', [StringComparison]::OrdinalIgnoreCase) -and
        $WebpConvertibleExtensions -contains [IO.Path]::GetExtension($Entry.relative)
}

<#
.SYNOPSIS
  把 evidence/ 底下可轉檔的圖片換成無損 WebP（同內容只轉一次）。不合格的保留原檔並記入 skipped。
  回傳 entries（轉檔後的完整清單）、converted（from、to、sourceBytes、webpBytes）、skipped（file、reason）。
#>
function Convert-PackEntriesToWebp {
    param([Parameter(Mandatory)][object[]]$Entries, [Parameter(Mandatory)]$Encoder, [Parameter(Mandatory)][string]$Staging)
    $result = [Collections.Generic.List[object]]::new()
    $converted = [Collections.Generic.List[object]]::new()
    $skipped = [Collections.Generic.List[object]]::new()
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($e in $Entries) { $null = $names.Add($e.relative) }
    $byContentAndFormat = @{}
    $batch = $null
    try {
        foreach ($e in @($Entries | Sort-Object -Property relative -CaseSensitive)) {
            if (-not (Test-PackEntryWebpCandidate $e)) {
                $result.Add($e); continue
            }
            $webpName = [IO.Path]::ChangeExtension($e.relative, '.webp').Replace('\', '/')
            if ($names.Contains($webpName)) {
                $skipped.Add([pscustomobject]@{ file = $e.relative; reason = 'name-conflict' }); $result.Add($e); continue
            }
            $format = [IO.Path]::GetExtension($e.relative).TrimStart('.').ToLowerInvariant() -replace '^jpg$', 'jpeg'
            $cacheKey = "$($e.sha256)-$format"
            if (-not $byContentAndFormat.ContainsKey($cacheKey)) {
                if ($batch -and $batch.HasExited) {
                    Stop-WebpBatch $batch
                    $batch = $null
                }
                if (-not $batch) { $batch = Start-WebpBatch $Encoder }
                $destination = Join-Path $Staging "webp/$cacheKey.webp"
                $outcome = Convert-ToLosslessWebp -Source $e.path -Destination $destination -Encoder $Encoder -Batch $batch
                $outcome.path = $destination
                $byContentAndFormat[$cacheKey] = $outcome
            }
            $c = $byContentAndFormat[$cacheKey]
            if (-not $c.ok) { $skipped.Add([pscustomobject]@{ file = $e.relative; reason = $c.reason }); $result.Add($e); continue }
            $null = $names.Add($webpName)
            $extra = [ordered]@{}
            foreach ($k in $e.extra.Keys) { $extra[$k] = $e.extra[$k] }
            $extra.originalName = $e.relative
            $extra.originalSha256 = $e.sha256
            $extra.encoder = $c.encoder
            $extra.lossless = $true
            $new = New-PackEntry -Relative $webpName -Path $c.path -Extra $extra
            $new.lastWrite = $e.lastWrite
            $result.Add($new)
            $converted.Add([pscustomobject]@{ from = $e.relative; to = $webpName; sourceBytes = $c.sourceBytes; webpBytes = $c.webpBytes })
        }
    } finally {
        if ($batch) { Stop-WebpBatch $batch }
    }
    [pscustomobject]@{ entries = @($result); converted = @($converted); skipped = @($skipped) }
}

<#
.SYNOPSIS
  依內容去重：每種 SHA-256 只存第一個（依相對路徑排序），其餘記為 alias。
  回傳 stored（要寫進 ZIP 的項目）、aliases（alias → canonical）、files（每個相對路徑的 manifest 紀錄，含 extra）。
#>
function Get-DedupPlan([Parameter(Mandatory)][object[]]$Entries) {
    $files = [ordered]@{}
    $aliases = [ordered]@{}
    $canonical = @{}
    $stored = [Collections.Generic.List[object]]::new()
    foreach ($e in @($Entries | Sort-Object -Property relative -CaseSensitive)) {
        if ($files.Contains($e.relative)) { throw "封存內有重複的路徑：$($e.relative)" }
        $record = [ordered]@{ sha256 = $e.sha256; size = $e.size }
        foreach ($k in $e.extra.Keys) { $record[$k] = $e.extra[$k] }
        $files[$e.relative] = $record
        if ($canonical.ContainsKey($e.sha256)) { $aliases[$e.relative] = $canonical[$e.sha256] }
        else { $canonical[$e.sha256] = $e.relative; $stored.Add($e) }
    }
    [pscustomobject]@{ stored = @($stored); aliases = $aliases; files = $files }
}

<#
.SYNOPSIS
  把 stored 項目與 manifest 寫成 ZIP（第一層為 Prefix），逐檔驗證後才搬到 Target。
  Target 已存在就丟例外；任何失敗都不留下暫存檔。
#>
function Write-BddZip {
    param(
        [Parameter(Mandatory)][object[]]$Stored,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Prefix,
        [Parameter(Mandatory)][string]$ManifestJson,
        [Parameter(Mandatory)][string]$Target
    )
    if (Test-Path -LiteralPath $Target) { throw "封存檔已存在，請使用新檔名，避免覆蓋：$Target" }
    $parent = Split-Path -Path $Target -Parent
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ([IO.Path]::GetRandomFileName() + '.zip.tmp')
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
        try {
            foreach ($f in $Stored) {
                $ext = [IO.Path]::GetExtension($f.relative).ToLowerInvariant()
                $level = if ($PrecompressedExtensions -contains $ext) { 'NoCompression' } else { 'Optimal' }
                $entry = $archive.CreateEntry($Prefix + $f.relative, [IO.Compression.CompressionLevel]::$level)
                $entry.LastWriteTime = $f.lastWrite
                $out = $entry.Open(); $in = [IO.File]::OpenRead($f.path)
                try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
            }
            $entry = $archive.CreateEntry($Prefix + $script:ManifestName, [IO.Compression.CompressionLevel]::Optimal)
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write($ManifestJson) } finally { $writer.Dispose() }
        } finally { $archive.Dispose(); $stream.Dispose() }

        $archive = [IO.Compression.ZipFile]::OpenRead($temporary)
        try {
            $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
            if ($entries.Count -ne $Stored.Count + 1) { throw "封存檔案數不符：應有 $($Stored.Count + 1)、ZIP $($entries.Count)" }
            foreach ($f in $Stored) {
                $entry = $archive.GetEntry($Prefix + $f.relative)
                if (-not $entry -or $entry.Length -ne $f.size) { throw "封存缺少或大小不符：$($f.relative)" }
                $s = $entry.Open()
                try { $hash = Get-Sha256Hex -Stream $s } finally { $s.Dispose() }
                if ($hash -ne $f.sha256) { throw "封存內容不符：$($f.relative)" }
            }
        } finally { $archive.Dispose() }

        Move-Item -LiteralPath $temporary -Destination $Target
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

Export-ModuleMember -Function * -Variable ManifestName
