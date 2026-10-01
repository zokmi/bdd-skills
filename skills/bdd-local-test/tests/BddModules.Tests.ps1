<#
  模組情境腳本的 Pester 測試。執行：
    pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddModules.Tests.ps1 -Output Detailed"
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'
    Import-Module (Join-Path $script:Scripts 'lib/BddModules.psm1') -Force

    # 建立空的測試 repo，回傳路徑
    function New-ModuleRepo([string]$Root) {
        $repo = Join-Path $Root 'repo'
        New-Item -ItemType Directory -Path $repo | Out-Null
        git -C $repo init -q -b main
        git -C $repo config user.email t@example.com
        git -C $repo config user.name tester
        $repo
    }

    # 寫入一個模組（MODULE.md 與 .feature），回傳模組目錄
    function Set-TestModule {
        param([string]$Repo, [string]$Name, [string]$Prefix, [string[]]$Paths = @('src/app/x/**'),
              [string[]]$Removed = @(), [hashtable]$Features = @{}, [switch]$NoFrontMatter)
        $dir = Join-Path $Repo ".bdd/modules/$Name"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $lines = if ($NoFrontMatter) { @("# $Name") } else {
            $l = @('---', "prefix: $Prefix", 'paths:') + @($Paths | ForEach-Object { "  - $_" }) + @('issues:', '  - 5349')
            if ($Removed.Count) { $l += 'removed:'; $l += @($Removed | ForEach-Object { "  - $_" }) }
            $l + @('---', '', "# $Name")
        }
        Set-Content -LiteralPath (Join-Path $dir 'MODULE.md') -Value $lines -Encoding utf8
        foreach ($k in $Features.Keys) { Set-Content -LiteralPath (Join-Path $dir $k) -Value $Features[$k] -Encoding utf8 }
        $dir
    }

    # 執行 bdd-modules.ps1，回傳 JSON 結果與 exit code
    function Invoke-Modules {
        param([hashtable]$Arguments)
        $out = & "$script:Scripts/bdd-modules.ps1" @Arguments 2>$null
        @{ json = ($out | ConvertFrom-Json); code = $LASTEXITCODE }
    }

    $script:ValidFeature = @'
# language: zh-TW
@SS
功能: 賽制管理列表

  @SS-01 @#5349 @UI
  場景: 列表顯示組別名稱
    當 我開啟列表
    那麼 看到組別名稱

  @SS-02 @#5354 @UI @DB
  場景大綱: 字級
    當 我開啟列表
    那麼 字級為 <大小>

    例子:
      | 大小 |
      | 14px |
'@
}

Describe 'BddModules.psm1' {
    BeforeEach {
        $repo = New-ModuleRepo (Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    }

    It '解析 front matter 的純量與清單' {
        $dir = Set-TestModule -Repo $repo -Name 'organizer/schedule-settings' -Prefix 'SS' -Removed @('SS-07 #5400 需求取消')
        $fm = Read-ModuleFrontMatter (Join-Path $dir 'MODULE.md')
        $fm['prefix'] | Should -Be 'SS'
        @($fm['paths']) | Should -Be @('src/app/x/**')
        @($fm['removed']) | Should -Be @('SS-07 #5400 需求取消')
    }

    It '沒有 front matter 時丟出例外' {
        $dir = Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -NoFrontMatter
        { Read-ModuleFrontMatter (Join-Path $dir 'MODULE.md') } | Should -Throw '*front matter*'
    }

    It '解析情境：編號、單號、驗證手段，功能層標籤不算進情境' {
        $dir = Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01-list.feature' = $script:ValidFeature }
        $s = @(Get-FeatureScenarios (Join-Path $dir '01-list.feature'))
        $s.Count | Should -Be 2
        $s[0].ids | Should -Be @('SS-01')
        $s[0].issues | Should -Be @('5349')
        $s[0].methods | Should -Be @('UI')
        $s[0].tags | Should -Not -Contain '@SS'
        $s[1].methods | Should -Be @('UI', 'DB')
        $s[1].title | Should -Be '字級'
    }

    It '全形冒號的場景標題也能解析' {
        $dir = Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01.feature' = "功能: x`n  @SS-01 @#1 @API`n  場景：全形冒號`n    當 a" }
        @(Get-FeatureScenarios (Join-Path $dir '01.feature'))[0].title | Should -Be '全形冒號'
    }

    It '合法的模組沒有任何問題' {
        Set-TestModule -Repo $repo -Name 'organizer/schedule-settings' -Prefix 'SS' -Features @{ '01-list.feature' = $script:ValidFeature } | Out-Null
        @(Test-BddModules $repo).Count | Should -Be 0
    }

    It '同模組編號重複' {
        $dup = $script:ValidFeature.Replace('@SS-02', '@SS-01')
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01.feature' = $dup } | Out-Null
        @(Test-BddModules $repo).rule | Should -Contain 'duplicate-id'
    }

    It '跨模組前綴重複' {
        Set-TestModule -Repo $repo -Name 'a' -Prefix 'SS' | Out-Null
        Set-TestModule -Repo $repo -Name 'b' -Prefix 'SS' | Out-Null
        @(Test-BddModules $repo).rule | Should -Contain 'duplicate-prefix'
    }

    It '缺少單號標籤或驗證手段標籤' {
        $bad = "功能: x`n  @SS-01 @UI`n  場景: 沒有單號`n    當 a`n`n  @SS-02 @#1`n  場景: 沒有手段`n    當 a"
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01.feature' = $bad } | Out-Null
        $rules = @(Test-BddModules $repo).rule
        $rules | Should -Contain 'missing-issue-tag'
        $rules | Should -Contain 'missing-method-tag'
    }

    It '編號前綴不是本模組登記的前綴' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'MT' -Features @{ '01.feature' = $script:ValidFeature } | Out-Null
        @(Test-BddModules $repo).rule | Should -Contain 'unknown-prefix'
    }

    It '情境沒有編號或有兩個編號' {
        $bad = "功能: x`n  @#1 @UI`n  場景: 沒編號`n    當 a`n`n  @SS-01 @SS-02 @#1 @UI`n  場景: 兩個編號`n    當 a"
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01.feature' = $bad } | Out-Null
        @(Test-BddModules $repo | Where-Object rule -eq 'scenario-id').Count | Should -Be 2
    }

    It '用回 MODULE.md 記為已移除的編號' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Removed @('SS-02 #5400 需求取消') -Features @{ '01.feature' = $script:ValidFeature } | Out-Null
        @(Test-BddModules $repo).rule | Should -Contain 'reused-id'
    }

    It 'MODULE.md 格式錯誤：前綴不合規、缺少 paths、沒有 front matter' {
        Set-TestModule -Repo $repo -Name 'a' -Prefix 'ss' | Out-Null
        Set-TestModule -Repo $repo -Name 'b' -Prefix 'AB' -Paths @() | Out-Null
        Set-TestModule -Repo $repo -Name 'c' -Prefix 'CD' -NoFrontMatter | Out-Null
        @(Test-BddModules $repo | Where-Object rule -eq 'module-format').Count | Should -Be 3
    }

    It '沒有 MODULE.md 的目錄裡有 .feature' {
        $dir = Join-Path $repo '.bdd/modules/orphan'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $dir '01.feature') -Value $script:ValidFeature -Encoding utf8
        @(Test-BddModules $repo).rule | Should -Contain 'orphan-feature'
    }

    It '下一個編號取現有與已移除的最大號加一' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Removed @('SS-07 #5400 需求取消') -Features @{ '01.feature' = $script:ValidFeature } | Out-Null
        Get-NextScenarioId (Get-BddModules $repo)[0] | Should -Be 'SS-08'
    }

    It '空模組的第一個編號是 01' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'MT' | Out-Null
        Get-NextScenarioId (Get-BddModules $repo)[0] | Should -Be 'MT-01'
    }

    It 'glob：** 可跨目錄、* 不跨目錄、不分大小寫' {
        $rx = [regex]::new((ConvertTo-GlobRegex 'src/app/**'), 'IgnoreCase')
        $rx.IsMatch('src/app/a/b.ts') | Should -BeTrue
        $rx.IsMatch('SRC/App/b.ts') | Should -BeTrue
        $rx.IsMatch('src/other/b.ts') | Should -BeFalse
        $one = [regex]::new((ConvertTo-GlobRegex 'src/*.ts'), 'IgnoreCase')
        $one.IsMatch('src/a.ts') | Should -BeTrue
        $one.IsMatch('src/x/a.ts') | Should -BeFalse
    }

    It '依異動檔案找出模組；.bdd/ 底下的檔案不算' {
        Set-TestModule -Repo $repo -Name 'organizer/schedule-settings' -Prefix 'SS' -Paths @('Project/frontend/organizer-portal/src/app/pages/schedule-settings/**') | Out-Null
        Set-TestModule -Repo $repo -Name 'organizer/shared/category-tabs' -Prefix 'CT' -Paths @('Project/frontend/organizer-portal/src/app/shared/category-tabs/**') | Out-Null
        $r = Find-ModulesForPaths -RepoRoot $repo -Paths @(
            'Project/frontend/organizer-portal/src/app/pages/schedule-settings/list.component.ts',
            'Project/frontend/organizer-portal/src/app/shared/category-tabs/tabs.scss',
            'Project/backend/Other.cs',
            '.bdd/5349-x/REPORT.md')
        @($r.modules.name) | Should -Be @('organizer/schedule-settings', 'organizer/shared/category-tabs')
        @($r.unmatched) | Should -Be @('Project/backend/Other.cs')
    }
}

Describe 'bdd-modules.ps1' {
    BeforeEach {
        $repo = New-ModuleRepo (Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    }

    It '-Lint 通過時 exit 0，有問題時 exit 1 並列出問題' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Features @{ '01.feature' = $script:ValidFeature } | Out-Null
        $ok = Invoke-Modules @{ Repo = $repo; Lint = $true }
        $ok.code | Should -Be 0
        @($ok.json.problems).Count | Should -Be 0

        Set-TestModule -Repo $repo -Name 'n' -Prefix 'SS' | Out-Null
        $bad = Invoke-Modules @{ Repo = $repo; Lint = $true }
        $bad.code | Should -Be 1
        @($bad.json.problems).rule | Should -Contain 'duplicate-prefix'
    }

    It '-NextId 回傳下一個編號；找不到模組時 exit 2' {
        Set-TestModule -Repo $repo -Name 'organizer/schedule-settings' -Prefix 'SS' -Features @{ '01.feature' = $script:ValidFeature } | Out-Null
        (Invoke-Modules @{ Repo = $repo; NextId = $true; Module = 'organizer/schedule-settings' }).json.next | Should -Be 'SS-03'
        (Invoke-Modules @{ Repo = $repo; NextId = $true; Module = 'nope' }).code | Should -Be 2
    }

    It '-Base 以 git 差異找出模組' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Paths @('src/app/x/**') | Out-Null
        git -C $repo add . ; git -C $repo commit -q -m base
        New-Item -ItemType Directory -Path (Join-Path $repo 'src/app/x') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'src/app/x/a.ts') -Value 'x'
        git -C $repo add . ; git -C $repo commit -q -m change
        $r = Invoke-Modules @{ Repo = $repo; Base = 'HEAD~1' }
        $r.code | Should -Be 0
        @($r.json.modules.name) | Should -Be @('m')
    }

    It '沒有指定模式時 exit 2' {
        (Invoke-Modules @{ Repo = $repo }).code | Should -Be 2
    }
}
