<#
  模組情境腳本的 Pester 測試。執行：
    pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddModules.Tests.ps1 -Output Detailed"
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'

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
              [hashtable]$Features = @{})
        $dir = Join-Path $Repo ".bdd/modules/$Name"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $lines = @('---', "prefix: $Prefix", 'paths:') + @($Paths | ForEach-Object { "  - $_" }) + @('---', '', "# $Name")
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
        Set-TestModule -Repo $repo -Name 'empty' -Prefix 'MT' | Out-Null
        (Invoke-Modules @{ Repo = $repo; NextId = $true; Module = 'empty' }).json.next | Should -Be 'MT-01'
        (Invoke-Modules @{ Repo = $repo; NextId = $true; Module = 'nope' }).code | Should -Be 2
    }

    It '-ForPaths 以不分大小寫的 glob 對應多個模組並排除 .bdd 輸出' {
        Set-TestModule -Repo $repo -Name 'list' -Prefix 'LS' -Paths @('src/list/**') | Out-Null
        Set-TestModule -Repo $repo -Name 'shared' -Prefix 'SH' -Paths @('src/shared/*.ts') | Out-Null
        $r = Invoke-Modules @{ Repo = $repo; ForPaths = @('SRC/LIST/sub/a.ts', 'src/shared/b.ts', 'src/shared/sub/c.ts', '.bdd/123-x/REPORT.md') }
        $r.code | Should -Be 0
        @($r.json.modules.name) | Should -Be @('list', 'shared')
        @($r.json.unmatched) | Should -Be @('src/shared/sub/c.ts')
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

    It '-Base 能對應中文的未追蹤路徑' {
        Set-TestModule -Repo $repo -Name 'm' -Prefix 'SS' -Paths @('src/**') | Out-Null
        git -C $repo add .
        git -C $repo commit -q -m base
        git -C $repo config core.quotepath true
        New-Item -ItemType Directory (Join-Path $repo 'src') | Out-Null
        Set-Content (Join-Path $repo 'src/中文.txt') 'x'
        $r = Invoke-Modules @{ Repo = $repo; Base = 'HEAD' }
        $r.code | Should -Be 0
        @($r.json.modules.name) | Should -Be @('m')
        @($r.json.unmatched).Count | Should -Be 0
    }

    It '沒有指定模式時 exit 2' {
        (Invoke-Modules @{ Repo = $repo }).code | Should -Be 2
    }
}
