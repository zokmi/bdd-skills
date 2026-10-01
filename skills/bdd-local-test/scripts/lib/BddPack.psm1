<#
.SYNOPSIS
  BDD 封存的打包管線：建立封存項目、依內容去重、寫入 ZIP 並逐檔驗證。
  後續任務在此加入情境快照、WebP 轉檔、改寫 Markdown 連結與遮罩紀錄。

.DESCRIPTION
  由 archive-bdd.ps1 與 recompress-bdd.ps1 匯入。封存項目（PackEntry）把「封存內的相對路徑」與「實體檔位置」分開，
  讓轉檔或改寫後的檔案可以先放在暫存目錄，再以原本的相對路徑收進 ZIP。
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
    param([Parameter(Mandatory)][string]$Relative, [Parameter(Mandatory)][string]$Path, $Extra = $null)
    $item = Get-Item -LiteralPath $Path
    $copy = [ordered]@{}
    if ($Extra) { foreach ($k in $Extra.Keys) { $copy[$k] = $Extra[$k] } }
    [pscustomobject]@{
        relative = $Relative.Replace('\', '/')
        path = $item.FullName
        sha256 = Get-Sha256Hex -Path $item.FullName
        size = $item.Length
        lastWrite = $item.LastWriteTime
        extra = $copy
    }
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
    # 以序數（ordinal）比較排序，結果不受文化特性影響，canonical 的選擇才穩定
    $sorted = [Collections.Generic.List[object]]::new($Entries)
    $sorted.Sort([Comparison[object]]{ param($x, $y) [string]::CompareOrdinal($x.relative, $y.relative) })
    foreach ($e in $sorted) {
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
