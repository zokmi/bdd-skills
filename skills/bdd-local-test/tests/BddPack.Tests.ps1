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
        @($plan.stored).relative | Should -Be @('evidence/R1_a.txt', 'REPORT.md')
        $plan.aliases['evidence/R2_a.txt'] | Should -Be 'evidence/R1_a.txt'
        $plan.files['evidence/R2_a.txt'].originalName | Should -Be 'evidence/R2_a.png'
        $plan.files.Count | Should -Be 3
    }

    It '封存共用一個編碼器行程，單張失敗後繼續且相同內容只轉一次' {
        $helper = New-TextFile $dir 'encoder.ps1' @'
$log = Join-Path $PSScriptRoot 'encoder.log'
Add-Content -LiteralPath $log -Value "start:$($args[0])"
function Convert-Fixture($source, $destination) {
    Add-Content -LiteralPath $log -Value ([IO.Path]::GetFileName($source))
    if ([IO.Path]::GetFileName($source) -eq 'b.png') {
        '{"error":"invalid image"}'
        return
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::WriteAllBytes($destination, [byte[]](1, 2, 3))
    '{"identical":true}'
}
if ($args[0] -eq 'convert') { Convert-Fixture $args[1] $args[2]; exit }
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = ConvertFrom-Json -InputObject $line
    Convert-Fixture $request.source $request.destination
}
'@
        $encoder = @{ kind = 'pillow'; command = (Get-Process -Id $PID).Path; prefixArgs = @('-NoProfile', '-File'); helper = $helper }
        $a = New-PackEntry -Relative 'evidence/a.png' -Path (New-TextFile $dir 'a.png' 'first image payload')
        $b = New-PackEntry -Relative 'evidence/b.png' -Path (New-TextFile $dir 'b.png' 'invalid image payload')
        $c = New-PackEntry -Relative 'evidence/c 中文.png' -Path (New-TextFile $dir 'c 中文.png' 'second image payload')
        $alias = New-PackEntry -Relative 'evidence/d.png' -Path (New-TextFile $dir 'd.png' 'first image payload')

        $pack = Convert-PackEntriesToWebp -Entries @($a, $b, $c, $alias) -Encoder $encoder -Staging (Join-Path $dir 'staging')

        $pack.entries.relative | Should -Be @('evidence/a.webp', 'evidence/b.png', 'evidence/c 中文.webp', 'evidence/d.webp')
        $pack.skipped.reason | Should -Be 'encoder-failed'
        $pack.entries[0].path | Should -BeExactly $pack.entries[3].path
        @(Get-Content -LiteralPath (Join-Path $dir 'encoder.log')) | Should -Be @('start:batch', 'a.png', 'b.png', 'c 中文.png')
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
