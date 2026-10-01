<#
  封存打包管線（BddPack.psm1）的 Pester 測試。
#>

BeforeAll {
    $script:Lib = Join-Path $PSScriptRoot '../scripts/lib'
    Import-Module (Join-Path $script:Lib 'BddArchive.psm1') -Force
    Import-Module (Join-Path $script:Lib 'BddPack.psm1') -Force
    Add-Type -AssemblyName System.IO.Compression

    # 在目錄下寫入文字檔，回傳完整路徑
    function New-TextFile([string]$Dir, [string]$Name, [string]$Text) {
        $p = Join-Path $Dir $Name
        [IO.Directory]::CreateDirectory((Split-Path $p -Parent)) | Out-Null
        [IO.File]::WriteAllText($p, $Text, [Text.UTF8Encoding]::new($false))
        $p
    }
}

Describe 'BddPack.psm1' {
    BeforeEach {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $dir | Out-Null
    }

    It 'New-PackEntry 計算 SHA-256、大小並保留 extra' {
        $p = New-TextFile $dir 'a.txt' 'hello'
        $e = New-PackEntry -Relative 'evidence/a.txt' -Path $p -Extra ([ordered]@{ note = 'x' })
        $e.sha256 | Should -Be (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
        $e.size | Should -Be 5
        $e.extra.note | Should -Be 'x'
    }

    It 'Get-DedupPlan：同內容只存一份，其餘記為 alias，manifest 紀錄含 extra' {
        $a = New-PackEntry -Relative 'evidence/R1_a.txt' -Path (New-TextFile $dir 'a.txt' 'same')
        $b = New-PackEntry -Relative 'evidence/R2_a.txt' -Path (New-TextFile $dir 'b.txt' 'same') -Extra ([ordered]@{ originalName = 'evidence/R2_a.png' })
        $c = New-PackEntry -Relative 'REPORT.md' -Path (New-TextFile $dir 'c.md' 'report')
        $plan = Get-DedupPlan @($b, $c, $a)
        @($plan.stored).relative | Should -Be @('REPORT.md', 'evidence/R1_a.txt')
        $plan.aliases['evidence/R2_a.txt'] | Should -Be 'evidence/R1_a.txt'
        $plan.files['evidence/R2_a.txt'].originalName | Should -Be 'evidence/R2_a.png'
        $plan.files.Count | Should -Be 3
    }

    It 'Write-BddZip 寫入前綴與 manifest，並拒絕覆蓋既有檔' {
        $e = New-PackEntry -Relative 'REPORT.md' -Path (New-TextFile $dir 'r.md' 'report')
        $target = Join-Path $dir 'out/x.zip'
        Write-BddZip -Stored @($e) -Prefix 'topic/' -ManifestJson '{"schema":2}' -Target $target
        $zip = [IO.Compression.ZipFile]::OpenRead($target)
        try { @($zip.Entries.FullName | Sort-Object) | Should -Be @('topic/bdd-manifest.json', 'topic/REPORT.md') } finally { $zip.Dispose() }
        { Write-BddZip -Stored @($e) -Prefix 'topic/' -ManifestJson '{}' -Target $target } | Should -Throw '*已存在*'
        @(Get-ChildItem -LiteralPath (Join-Path $dir 'out') -Filter '*.tmp').Count | Should -Be 0
    }
}
