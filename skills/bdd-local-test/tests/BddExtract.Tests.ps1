BeforeAll {
    $extract = Join-Path $PSScriptRoot '../scripts/extract-bdd.ps1'

    function New-ExtractFixture($Path, $Entries, $Manifest) {
        $zip = [IO.Compression.ZipFile]::Open($Path, 'Create')
        try {
            if ($null -ne $Manifest) {
                $Entries['topic/bdd-manifest.json'] = ConvertTo-Json -InputObject $Manifest -Depth 5 -Compress
            }
            foreach ($entry in $Entries.GetEnumerator()) {
                $writer = [IO.StreamWriter]::new($zip.CreateEntry($entry.Key).Open())
                try { $writer.Write($entry.Value) } finally { $writer.Dispose() }
            }
        } finally { $zip.Dispose() }
    }
}

Describe 'BDD ZIP extraction' {
    BeforeEach {
        $root = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $to = Join-Path $root 'output'
        $zip = Join-Path $root 'fixture.zip'
        [IO.Directory]::CreateDirectory($root) | Out-Null
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes('original')))
    }

    It 'rejects oversized output including aliases before publishing files' {
        Import-Module (Join-Path $PSScriptRoot '../scripts/lib/BddExtract.psm1') -Force
        New-ExtractFixture $zip @{ 'topic/data.txt' = 'original' } @{
            topic = 'topic'
            aliases = @{ 'copy.txt' = 'data.txt' }
        }
        { Expand-BddArchive -Archive $zip -To $to -MaxOutputBytes 12 } | Should -Throw '*位元組上限*'
        Test-Path -LiteralPath $to | Should -BeFalse
    }

    It 'rejects a ZIP with too many entries before publishing files' {
        Import-Module (Join-Path $PSScriptRoot '../scripts/lib/BddExtract.psm1') -Force
        New-ExtractFixture $zip @{ 'first.txt' = 'original'; 'second.txt' = 'original' } $null
        { Expand-BddArchive -Archive $zip -To $to -MaxEntries 1 } | Should -Throw '*項目數上限*'
        Test-Path -LiteralPath $to | Should -BeFalse
    }

    It 'rejects unsafe names in old evidence.zip before restoring any screenshot' {
        Import-Module (Join-Path $PSScriptRoot '../scripts/lib/BddExtract.psm1') -Force
        New-ExtractFixture $zip ([ordered]@{ 'valid.png' = 'original'; 'nested/file.png:alternate' = 'bad' }) $null
        { Expand-BddArchive -Archive $zip -To $to -EvidenceZip } | Should -Throw '*不安全的路徑*'
        Test-Path -LiteralPath $to | Should -BeFalse
    }

    It 'rejects unsafe manifest <field> without writing any payload' -ForEach @(
        @{ field = 'topic'; value = '../outside' }
        @{ field = 'alias destination'; value = '../outside.txt' }
        @{ field = 'alias source'; value = '../../sentinel.txt' }
        @{ field = 'alias source already on disk'; value = 'on-disk.txt' }
        @{ field = 'file'; value = '../../sentinel.txt' }
    ) {
        [IO.Directory]::CreateDirectory((Join-Path $to 'topic')) | Out-Null
        [IO.File]::WriteAllText((Join-Path $root 'sentinel.txt'), 'original')
        [IO.File]::WriteAllText((Join-Path $to 'topic/on-disk.txt'), 'original')
        $manifest = @{
            topic = 'topic'
            aliases = @{ 'copy.txt' = 'data.txt' }
            files = @{ 'data.txt' = @{ sha256 = $hash }; 'copy.txt' = @{ sha256 = $hash } }
        }
        switch ($field) {
            'topic' { $manifest.topic = $value }
            'alias destination' { $manifest.aliases = @{ $value = 'data.txt' } }
            'alias source' { $manifest.aliases['copy.txt'] = $value }
            'alias source already on disk' { $manifest.aliases['copy.txt'] = $value }
            'file' { $manifest.files[$value] = @{ sha256 = $hash } }
        }
        New-ExtractFixture $zip @{ 'topic/data.txt' = 'original' } $manifest
        { & $extract -Archive $zip -To $to } | Should -Throw
        @(Get-ChildItem -LiteralPath $to -Recurse -File).Name | Should -Be @('on-disk.txt')
        Test-Path -LiteralPath (Join-Path $root 'outside') | Should -BeFalse
    }

    It 'rejects traversal in a legacy ZIP before publishing earlier files' {
        New-ExtractFixture $zip ([ordered]@{ 'topic/data.txt' = 'original'; '../outside.txt' = 'bad' }) $null
        { & $extract -Archive $zip -To $to } | Should -Throw
        Test-Path -LiteralPath (Join-Path $to 'topic/data.txt') | Should -BeFalse
        Test-Path -LiteralPath (Join-Path $root 'outside.txt') | Should -BeFalse
    }

    It 'rejects a Windows junction inside the output tree' -Skip:(-not $IsWindows) {
        $outside = [IO.Directory]::CreateDirectory((Join-Path $root 'outside'))
        [IO.Directory]::CreateDirectory($to) | Out-Null
        $junction = Join-Path $to 'topic'
        New-Item -ItemType Junction -Path $junction -Target $outside.FullName -ErrorAction Stop | Out-Null
        try {
            New-ExtractFixture $zip @{ 'topic/data.txt' = 'original' } $null
            { & $extract -Archive $zip -To $to } | Should -Throw
            Test-Path -LiteralPath (Join-Path $outside.FullName 'data.txt') | Should -BeFalse
        } finally { [IO.Directory]::Delete($junction) }
    }

    It 'rejects a hash mismatch without publishing the corrupted file' {
        New-ExtractFixture $zip @{ 'topic/data.txt' = 'changed' } @{
            topic = 'topic'
            files = @{ 'data.txt' = @{ sha256 = $hash } }
        }
        { & $extract -Archive $zip -To $to } | Should -Throw '*內容不符*'
        Test-Path -LiteralPath (Join-Path $to 'topic/data.txt') | Should -BeFalse
    }

    It 'rejects multiple manifest hashes for the same normalized path' {
        New-ExtractFixture $zip @{ 'topic/nested/data.txt' = 'original' } @{
            topic = 'topic'
            files = [ordered]@{
                'nested/data.txt' = @{ sha256 = '0' * 64 }
                'nested\data.txt' = @{ sha256 = $hash }
            }
        }
        { & $extract -Archive $zip -To $to } | Should -Throw '*路徑重複*'
        Test-Path -LiteralPath (Join-Path $to 'topic/nested/data.txt') | Should -BeFalse
    }

    It 'restores a manifest ZIP with aliases, then skips both identical files on retry' {
        New-ExtractFixture $zip @{ 'topic/data.txt' = 'original' } @{
            topic = 'topic'
            aliases = @{ 'copy.txt' = 'data.txt' }
            files = @{ 'data.txt' = @{ sha256 = $hash }; 'copy.txt' = @{ sha256 = $hash } }
        }
        $first = & $extract -Archive $zip -To $to | ConvertFrom-Json
        $first.written | Should -Be 1
        $first.restoredAliases | Should -Be 1
        $first.verifiedFiles | Should -Be 2
        Get-Content -LiteralPath (Join-Path $to 'topic/copy.txt') -Raw | Should -BeExactly 'original'
        $second = & $extract -Archive $zip -To $to | ConvertFrom-Json
        $second.skippedIdentical | Should -Be 2
    }

    It 'restores a legacy ZIP without a manifest' {
        New-ExtractFixture $zip @{ 'old/nested/data.txt' = 'original'; 'REPORT.md' = 'legacy report' } $null
        $result = & $extract -Archive $zip -To $to | ConvertFrom-Json
        $result.hasManifest | Should -BeFalse
        $result.written | Should -Be 2
        Get-Content -LiteralPath (Join-Path $to 'old/nested/data.txt') -Raw | Should -BeExactly 'original'
        Get-Content -LiteralPath (Join-Path $to 'REPORT.md') -Raw | Should -BeExactly 'legacy report'
    }

    It 'restores a legacy recompressed ZIP when its index topic differs from the ZIP folder' {
        New-ExtractFixture $zip @{ 'topic/data.txt' = 'original' } @{
            topic = 'old-index-topic'
            legacy = $true
            aliases = @{ 'copy.txt' = 'data.txt' }
            files = @{ 'data.txt' = @{ sha256 = $hash }; 'copy.txt' = @{ sha256 = $hash } }
        }
        $result = & $extract -Archive $zip -To $to | ConvertFrom-Json
        $result.folder | Should -Be (Join-Path $to 'topic')
        $result.verifiedFiles | Should -Be 2
        Get-Content -LiteralPath (Join-Path $to 'topic/copy.txt') -Raw | Should -BeExactly 'original'
    }
}
