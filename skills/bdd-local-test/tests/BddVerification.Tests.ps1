<#
  bdd-verification.ps1 的 Pester 測試（模組情境紀錄與比對）。
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'

    # 建立 repo：init → 加入模組情境與程式異動；回傳 repo、base（第一個 commit）
    function New-VerificationRepo([string]$Root) {
        $repo = Join-Path $Root 'repo'
        New-Item -ItemType Directory -Path $repo | Out-Null
        git -C $repo init -q -b main
        git -C $repo config user.email t@example.com
        git -C $repo config user.name tester
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'x'
        git -C $repo add . ; git -C $repo commit -q -m init
        $base = (git -C $repo rev-parse HEAD).Trim()
        $mod = Join-Path $repo '.bdd/modules/m'
        New-Item -ItemType Directory -Path $mod -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mod '01.feature') -Encoding utf8 -Value "功能: x`n  @SS-01 @#1 @UI`n  場景: 一`n    當 a`n`n  @SS-02 @#1 @UI`n  場景: 二`n    當 a"
        Set-Content -LiteralPath (Join-Path $mod '02.feature') -Encoding utf8 -Value "功能: y`n  @SS-05 @#1 @API`n  場景: 五`n    當 a`n`n  @SS-06 @#1 @API`n  場景: 六`n    當 a"
        New-Item -ItemType Directory -Path (Join-Path $repo 'src') | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'src/a.ts') -Value 'a'
        New-Item -ItemType Directory -Path (Join-Path $repo '.bdd/1-demo') -Force | Out-Null
        git -C $repo add . ; git -C $repo commit -q -m feat
        @{ repo = $repo; base = $base; bdd = (Join-Path $repo '.bdd/1-demo') }
    }

    # 在 repo 目錄下執行 bdd-verification.ps1，回傳 JSON 與 exit code
    function Invoke-Verification([string]$Repo, [hashtable]$Arguments) {
        Push-Location $Repo
        try {
            $out = & "$script:Scripts/bdd-verification.ps1" @Arguments 2>$null
            @{ json = ($out | ConvertFrom-Json); code = $LASTEXITCODE }
        } finally { Pop-Location }
    }
}

Describe 'bdd-verification.ps1 模組情境' {
    BeforeEach {
        $t = New-VerificationRepo (Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    }

    It '-Record 記下 changed 與 regression 情境：路徑、blob、編號' {
        $r = Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; Passed = 3
            ChangedScenarios = @('.bdd/modules/m/01.feature'); RegressionScenarios = @('.bdd/modules/m/02.feature::SS-05') }
        $r.code | Should -Be 0
        $s = @($r.json.scenarios)
        $s.Count | Should -Be 2
        $s[0].path | Should -Be '.bdd/modules/m/01.feature'
        $s[0].role | Should -Be 'changed'
        $s[0].ids | Should -Be @('SS-01', 'SS-02')
        $s[0].blob | Should -Be (git -C $t.repo rev-parse 'HEAD:.bdd/modules/m/01.feature').Trim()
        $s[1].role | Should -Be 'regression'
        ($s[1].ids -is [array]) | Should -BeTrue
        $s[1].ids | Should -Be @('SS-05')
        $saved = Get-Content (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json
        ($saved.rounds[-1].scenarios[1].ids -is [array]) | Should -BeTrue
    }

    It '情境檔沒變、HEAD 前進時判 still-valid' {
        Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/01.feature') } | Out-Null
        Set-Content -LiteralPath (Join-Path $t.repo 'README.md') -Value 'y'
        git -C $t.repo commit -qam other
        $c = Invoke-Verification $t.repo @{ Check = $true; Dir = '.bdd/1-demo' }
        $c.json.verdict | Should -Be 'still-valid'
        $c.code | Should -Be 0
    }

    It '情境檔被改過時判 rerun 並列出檔案' {
        Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/01.feature') } | Out-Null
        Add-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/01.feature') -Value "`n  @SS-03 @#2 @UI`n  場景: 三`n    當 a"
        git -C $t.repo commit -qam 'change scenario'
        $c = Invoke-Verification $t.repo @{ Check = $true; Dir = '.bdd/1-demo' }
        $c.json.verdict | Should -Be 'rerun'
        $c.code | Should -Be 1
        @($c.json.changedScenarios) | Should -Be @('.bdd/modules/m/01.feature')
    }

    It '未提交的情境檔：blob 為 null，並列入 dirtyPaths' {
        Add-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/01.feature') -Value "`n  @SS-03 @#2 @UI`n  場景: 三`n    當 a"
        $r = Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/01.feature') }
        $r.json.scenarios[0].blob | Should -Not -BeNullOrEmpty
        @($r.json.dirtyPaths) | Should -Contain '.bdd/modules/m/01.feature'
        $c = Invoke-Verification $t.repo @{ Check = $true; Dir = '.bdd/1-demo' }
        $c.json.verdict | Should -Be 'rerun'
    }

    It '從 repo 子目錄比對也能偵測未提交的情境異動' {
        Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/01.feature') } | Out-Null
        Add-Content (Join-Path $t.repo '.bdd/modules/m/01.feature') '  # dirty'
        $c = Invoke-Verification (Join-Path $t.repo '.bdd') @{ Check = $true; Dir = $t.bdd }
        $c.json.verdict | Should -Be 'rerun'
        $c.json.dirtyPaths | Should -Contain '.bdd/modules/m/01.feature'
    }

    It '新建未提交的情境檔：blob 為 null' {
        Set-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/03.feature') -Encoding utf8 -Value "功能: z`n  @SS-09 @#2 @UI`n  場景: 九`n    當 a"
        $r = Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/03.feature') }
        $r.json.scenarios[0].blob | Should -BeNullOrEmpty
        ($r.json.scenarios[0].ids -is [array]) | Should -BeTrue
        $r.json.scenarios[0].ids | Should -Be @('SS-09')
    }

    It '情境檔不存在時 exit 2' {
        $r = Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/99.feature') }
        $r.code | Should -Be 2
    }

    It '舊格式紀錄（沒有 scenarios）照常比對' {
        Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base } | Out-Null
        $c = Invoke-Verification $t.repo @{ Check = $true; Dir = '.bdd/1-demo' }
        $c.json.verdict | Should -Be 'current'
        @($c.json.changedScenarios).Count | Should -Be 0
    }
}
