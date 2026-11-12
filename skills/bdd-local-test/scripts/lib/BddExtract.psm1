# Shared ZIP reader for restore and recompression.
Import-Module (Join-Path $PSScriptRoot 'BddArchive.psm1')
Add-Type -AssemblyName System.IO.Compression

function Resolve-ZipPath([string]$Root, [string]$Name) {
    $relative = $Name.Replace('\', '/')
    foreach ($segment in $relative.Split('/')) {
        if (-not $segment -or $segment -match '[<>:"|?*\x00-\x1f]|[. ]$|^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)') {
            throw "封存含不安全的路徑：$Name"
        }
    }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $relative))
    if ($target -eq $Root -or -not (Test-PathUnder $target $Root)) {
        throw "封存含不安全的路徑：$Name"
    }
    $target
}

function Assert-SafeTarget([string]$Path, [switch]$Directory) {
    $current = $Path
    $expectDirectory = $Directory
    while ($current) {
        try { $attributes = [IO.File]::GetAttributes($current) }
        catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $attributes = $null }
        if ($null -ne $attributes) {
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "解壓路徑含重新解析點：$current"
            }
            if ([bool]($attributes -band [IO.FileAttributes]::Directory) -ne [bool]$expectDirectory) {
                throw "解壓路徑與現有檔案或目錄衝突：$current"
            }
        }
        $expectDirectory = $true
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Expand-ZipEntry($Entry, [string]$Path, [byte[]]$Buffer) {
    $digest = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $inputStream = $Entry.Open()
        try {
            $outputStream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $remaining = $Entry.Length
                while (($length = $inputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
                    $remaining -= $length
                    if ($remaining -lt 0) { throw "ZIP 項目實際大小與宣告不符：$($Entry.FullName)" }
                    $digest.AppendData($Buffer, 0, $length)
                    $outputStream.Write($Buffer, 0, $length)
                }
                if ($remaining -ne 0) { throw "ZIP 項目實際大小與宣告不符：$($Entry.FullName)" }
            } finally { $outputStream.Dispose() }
        } finally { $inputStream.Dispose() }
        [Convert]::ToHexString($digest.GetHashAndReset())
    } finally { $digest.Dispose() }
}

function Read-BddZipManifest($Entry) {
    if ($Entry.Length -gt 8MB) { throw '封存 manifest 超出 8 MiB 上限' }
    $stream = $Entry.Open()
    try {
        $binary = [IO.BinaryReader]::new($stream, [Text.Encoding]::UTF8, $true)
        try { $bytes = $binary.ReadBytes([int]$Entry.Length) } finally { $binary.Dispose() }
        if ($bytes.Length -ne $Entry.Length -or $stream.ReadByte() -ne -1) {
            throw '封存 manifest 實際大小與宣告不符'
        }
    } finally { $stream.Dispose() }
    $reader = [IO.StreamReader]::new([IO.MemoryStream]::new($bytes), [Text.Encoding]::UTF8)
    try { $reader.ReadToEnd() | ConvertFrom-Json -AsHashtable } finally { $reader.Dispose() }
}

function Expand-BddArchive {
    param(
        [Parameter(Mandatory)][string]$Archive,
        [Parameter(Mandatory)][string]$To,
        [switch]$EvidenceZip,
        [ValidateRange(1, 20000)][int]$MaxEntries = 20000,
        [ValidateRange(1, 4GB)][long]$MaxOutputBytes = 4GB
    )

    $ErrorActionPreference = 'Stop'
    $archivePath = Get-NormalizedPath $Archive
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "封存檔不存在：$archivePath" }
    $destination = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($To))
    Assert-SafeTarget -Path $destination -Directory

    $written = 0; $skipped = 0; $restored = 0; $verified = 0
    $folder = $null
    $manifest = $null
    $staging = $null
    $hashes = $null
    $writtenPaths = [Collections.Generic.List[string]]::new()
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($zip.Entries.Count -gt $MaxEntries) { throw "封存超出 ZIP 項目數上限：$MaxEntries" }
        $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        $manifests = @(if (-not $EvidenceZip) {
            $entries | Where-Object { $_.FullName.Replace('\', '/') -match '^[^/]+/bdd-manifest\.json$' }
        })
        if ($manifests.Count -gt 1) { throw '封存含多個 manifest' }
        $manifestEntry = $manifests | Select-Object -First 1
        if ($manifestEntry) {
            $manifest = Read-BddZipManifest $manifestEntry
            $topic = $manifest.topic
            $prefix = $manifestEntry.FullName.Replace('\', '/').Split('/')[0]
            if ($manifest -isnot [System.Collections.IDictionary] -or $topic -isnot [string] -or $topic -match '[/\\]') {
                throw '封存 manifest 的 topic 無效'
            }
            $folder = Resolve-ZipPath $destination $topic
            if ($topic -cne $prefix) {
                # 舊版 recompress 可能用索引 topic 填 manifest，並保留 ZIP 原本的第一層資料夾。
                if ($manifest.legacy -isnot [bool] -or -not $manifest.legacy) { throw '封存 manifest 的 topic 無效' }
                $folder = Resolve-ZipPath $destination $prefix
            }
            foreach ($key in @('aliases', 'files')) {
                if ($null -ne $manifest[$key] -and $manifest[$key] -isnot [System.Collections.IDictionary]) {
                    throw "封存 manifest 的 $key 無效"
                }
            }
        }

        $pathComparer = if ($IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal }
        $files = [Collections.Specialized.OrderedDictionary]::new($pathComparer)
        $hashes = [Collections.Specialized.OrderedDictionary]::new($pathComparer)
        foreach ($entry in $entries) {
            if ($entry -eq $manifestEntry) { continue }
            $name = $entry.FullName
            if ($EvidenceZip) {
                [void](Resolve-ZipPath $destination $name)
                $name = ConvertTo-EvidenceEntryPath $name
            }
            $target = Resolve-ZipPath $destination $name
            if ($files.Contains($target)) { throw "封存路徑重複：$($entry.FullName)" }
            $files[$target] = @{ entry = $entry; size = $entry.Length; lastWrite = $entry.LastWriteTime.LocalDateTime }
        }

        if ($manifestEntry) {
            foreach ($name in $(if ($manifest.aliases) { $manifest.aliases.get_Keys() })) {
                $target = Resolve-ZipPath $folder $name
                $source = Resolve-ZipPath $folder $manifest.aliases[$name]
                if ($files.Contains($target) -or -not $files.Contains($source) -or -not $files[$source].entry) {
                    throw "封存 manifest 的 alias 無效：$name"
                }
                if ($files.Count -ge $MaxEntries) { throw "封存超出還原檔案數上限：$MaxEntries" }
                $files[$target] = @{ source = $source; size = $files[$source].size; lastWrite = $files[$source].lastWrite }
            }
            foreach ($name in $(if ($manifest.files) { $manifest.files.get_Keys() })) {
                $target = Resolve-ZipPath $folder $name
                if (-not $files.Contains($target)) { throw "還原後缺少檔案：$name" }
                if ($files[$target].ContainsKey('expectedHash')) { throw "封存 manifest 的檔案路徑重複：$name" }
                $expectedHash = $manifest.files[$name].sha256
                if ($expectedHash -isnot [string] -or $expectedHash -notmatch '\A[a-f0-9]{64}\z') {
                    throw "封存 SHA-256 無效：$name"
                }
                $files[$target].expectedHash = $expectedHash
                $verified++
            }
        }

        $remainingBytes = $MaxOutputBytes
        foreach ($target in $files.Keys) {
            $remainingBytes -= $files[$target].size
            if ($remainingBytes -lt 0) { throw "封存超出還原位元組上限：$MaxOutputBytes" }
            Assert-SafeTarget $target
            $parent = [IO.Path]::GetDirectoryName($target)
            while ($parent -and $parent -ne $destination) {
                if ($files.Contains($parent)) { throw "封存檔案與目錄路徑衝突：$parent" }
                $parent = [IO.Path]::GetDirectoryName($parent)
            }
        }

        [IO.Directory]::CreateDirectory($destination) | Out-Null
        $staging = [IO.Path]::Combine($destination, '.bdd-extract-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        $buffer = [byte[]]::new(65536)
        $index = 0
        foreach ($target in $files.Keys) {
            $file = $files[$target]
            if ($file.entry) {
                $file.stagedPath = [IO.Path]::Combine($staging, [string]$index++)
                $file.hash = Expand-ZipEntry $file.entry $file.stagedPath $buffer
            } else {
                $canonical = $files[$file.source]
                $file.hash = $canonical.hash
            }
            $hashes[$target] = $file.hash
            if ($file.expectedHash -and $file.hash -ne $file.expectedHash) {
                throw "還原後內容不符：$target"
            }
            Assert-SafeTarget $target
            if ([IO.File]::Exists($target)) {
                if ((Get-Sha256Hex -Path $target) -ne $file.hash) {
                    throw "目的地已有同名但內容不同的檔案，不覆蓋：$target"
                }
                $file.skip = $true
                $skipped++
            } elseif ($file.source) {
                $file.stagedPath = [IO.Path]::Combine($staging, [string]$index++)
                [IO.File]::Copy($canonical.stagedPath, $file.stagedPath)
            }
            if (-not $file.skip) { [IO.File]::SetLastWriteTime($file.stagedPath, $file.lastWrite) }
        }

        foreach ($target in $files.Keys) {
            $file = $files[$target]
            if ($file.skip) { continue }
            Assert-SafeTarget $target
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.File]::Move($file.stagedPath, $target)
            $writtenPaths.Add($target)
            if ($file.source) { $restored++ } else { $written++ }
        }
    } finally {
        $zip.Dispose()
        if ($staging -and [IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $true) }
    }

    [pscustomobject]@{
        archive = $archivePath
        destination = $destination
        folder = $folder
        hasManifest = [bool]$manifestEntry
        written = $written
        restoredAliases = $restored
        skippedIdentical = $skipped
        verifiedFiles = $verified
        manifest = $manifest
        hashes = $hashes
        writtenPaths = $writtenPaths.ToArray()
    }
}

Export-ModuleMember -Function Expand-BddArchive
