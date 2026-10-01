# BDD 情境照模組累積、證據照 issue 冷封存 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 bdd-local-test 的情境改成照功能模組持續維護（`.bdd/modules/`），每張單的證據仍照 issue 封存，並在封存時把截圖轉成無損 WebP，讓本機封存庫約省 55%。

**Architecture:** 新增三個 PowerShell 模組：`BddModules.psm1`（解析 MODULE.md 與 .feature、檢查編號）、`BddImage.psm1`＋`bdd_webp.py`（以 Pillow 做無損轉檔與逐像素驗證）、`BddPack.psm1`（封存打包管線：去重、情境快照、轉檔、改寫連結與遮罩紀錄、寫入並驗證 ZIP）。`archive-bdd.ps1` 改用打包管線，新增 `recompress-bdd.ps1` 重新壓縮既有封存，`bdd-verification.ps1` 記錄本輪跑了哪些模組情境。SKILL.md 與 references 同步改寫流程。

**Tech Stack:** PowerShell 7（pwsh 7.6）、Pester 6、git、Python 3＋Pillow（選用，有 WebP 支援時才轉檔）、System.IO.Compression。

**Spec:** `docs/superpowers/specs/2026-10-01-bdd-module-scenarios-design.md`

## Global Constraints

- 所有腳本以 `pwsh -NoProfile -File` 執行，輸出 JSON；模組檔開頭 `Set-StrictMode -Version 3.0`。
- 新增或修改的函式、參數、輸出欄位一律補繁體中文說明（`<# .SYNOPSIS #>` 或行內註解），比照既有腳本。
- 不新增必要相依：沒有 Pillow 時封存照常成功，只是保留原格式並在 `warnings` 加 `webpUnavailable`。
- 轉檔只用無損 WebP（`lossless=True, exact=True`），解碼回 RGBA 逐像素一致且檔案較小才採用。
- issue 層資料夾路徑不變：`<repo>/.bdd/<單號>-<主題>/`；模組情境放 `<repo>/.bdd/modules/<portal>/<主路由>/`。
- 編號格式 `<2–3 大寫字母>-<兩位數以上>`，用過不重用；每個情境要有編號、單號標籤（`@#5349`）、驗證手段標籤（`@UI`／`@API`／`@DB`）。
- `bdd-modules.ps1` exit code：`0` 通過、`1` 有問題、`2` 參數或環境錯誤。
- 舊格式相容：issue 資料夾內含 `.feature`、`verification.json` 沒有 `scenarios` 時，封存與比對行為與 1.3.0 相同。
- git commit 訊息：`#0000 <type>(bdd-local-test): <中文摘要>`，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 工作分支：bdd-skills repo 的 `feature/module-scenarios`。
- 測試指令：`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`（在 bdd-skills repo 根目錄執行）。

## Review Focus

1. 截圖檔名含中文與空白（`R1_SS-01_列表 首頁.png`）：經 Python 轉檔後，檔名、manifest 與 ZIP 項目都要正確 → Task 3 測試。
2. 含透明像素的 PNG：無損轉檔後透明像素的 RGB 也要一致（`exact=True`），否則逐像素比對失敗 → Task 3 測試。
3. REPORT.md 以 URL 編碼引用中文截圖（`evidence/R2_DM-02_%E5%88%97%E8%A1%A8.png`）：改寫連結時也要換成 `.webp` → Task 6 測試。
4. 同名不同副檔名（`x.png` 與 `x.jpg`）都要轉成 `x.webp`：第二個要保留原格式並記錄 `name-conflict`，不可互相覆蓋 → Task 6 測試。
5. 從封存還原後接續下一輪再封存：資料夾已有 `features/`、`masking.json` 以 `.webp` 為鍵，再封存必須成功且不重複收錄 → Task 7 測試。

---

### Task 1：模組情境解析與檢查（`BddModules.psm1`＋`bdd-modules.ps1`）

**Files:**
- Create: `skills/bdd-local-test/scripts/lib/BddModules.psm1`
- Create: `skills/bdd-local-test/scripts/bdd-modules.ps1`
- Test: `skills/bdd-local-test/tests/BddModules.Tests.ps1`

**Interfaces:**
- Consumes: 無。
- Produces:
  - `Read-ModuleFrontMatter -Path <MODULE.md>` → `OrderedDictionary`（鍵：`prefix` 字串、`paths`／`issues`／`removed` 字串陣列）。
  - `Get-BddModules -RepoRoot <路徑>` → `pscustomobject[]`，欄位 `name`（相對 `.bdd/modules`，以 `/` 分隔）、`dir`、`modulePath`、`prefix`、`paths[]`、`issues[]`、`removed[]`（只有編號）、`errors[]`。
  - `Get-FeatureScenarios -Path <.feature>` → `pscustomobject[]`，欄位 `file`、`line`、`title`、`tags[]`、`ids[]`、`issues[]`、`methods[]`。
  - `Test-BddModules -RepoRoot <路徑>` → `pscustomobject[]`，欄位 `rule`、`module`、`file`、`line`、`message`。rule 值：`module-format`、`duplicate-prefix`、`orphan-feature`、`scenario-id`、`unknown-prefix`、`duplicate-id`、`reused-id`、`missing-issue-tag`、`missing-method-tag`。
  - `Get-NextScenarioId -Module <Get-BddModules 的一筆>` → 字串，例如 `SS-08`。
  - `ConvertTo-GlobRegex -Glob <glob>` → 正規表示式字串。
  - `Find-ModulesForPaths -RepoRoot <路徑> -Paths <字串[]>` → `pscustomobject`：`modules[]`（`name`、`files[]`）、`unmatched[]`。
  - CLI：`bdd-modules.ps1 -Repo <路徑> -Lint | -NextId -Module <名稱> | -ForPaths <檔案...> | -Base <ref>`。

- [ ] **Step 1：寫失敗的測試**

建立 `skills/bdd-local-test/tests/BddModules.Tests.ps1`：

```powershell
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
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddModules.Tests.ps1 -Output Detailed"`
Expected: FAIL，訊息含 `BddModules.psm1` 找不到（`Import-Module` 失敗）。

- [ ] **Step 3：實作 `BddModules.psm1`**

建立 `skills/bdd-local-test/scripts/lib/BddModules.psm1`：

```powershell
<#
.SYNOPSIS
  模組情境集（.bdd/modules/）的解析與檢查：MODULE.md front matter、.feature 情境標籤、編號規則、異動檔案對應模組。

.DESCRIPTION
  由 bdd-modules.ps1 與 bdd-verification.ps1 匯入。只做讀取與判斷，不改任何檔案。
#>

Set-StrictMode -Version 3.0

<#
.SYNOPSIS
  解析 MODULE.md 開頭以 --- 包住的 front matter。
  支援「鍵: 值」與「鍵:」後接「  - 項目」的清單；回傳 OrderedDictionary。格式錯誤時丟例外。
#>
function Read-ModuleFrontMatter([Parameter(Mandatory)][string]$Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding utf8)
    if (-not $lines.Count -or $lines[0].Trim() -ne '---') { throw "MODULE.md 缺少開頭的 --- front matter：$Path" }
    $data = [ordered]@{}
    $current = $null
    for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line.Trim() -eq '---') { return $data }
        if ($line -match '^\s+-\s+(.+?)\s*$') {
            if (-not $current) { throw "front matter 第 $($i + 1) 行的清單項目前面缺少鍵名：$Path" }
            $data[$current] = @($data[$current]) + $Matches[1]
            continue
        }
        if ($line -match '^([A-Za-z]+):\s*(.*?)\s*$') {
            $current = $Matches[1]
            $data[$current] = if ($Matches[2]) { $Matches[2] } else { @() }
            continue
        }
        if ($line.Trim()) { throw "無法解析 front matter 第 $($i + 1) 行：$Path" }
    }
    throw "front matter 沒有結尾的 ---：$Path"
}

<#
.SYNOPSIS
  列出 repo 內所有模組（每個含 MODULE.md 的目錄）。
  回傳欄位：name（相對 .bdd/modules，以 / 分隔）、dir、modulePath、prefix、paths、issues、removed（只取編號）、errors（解析錯誤訊息）。
#>
function Get-BddModules([Parameter(Mandatory)][string]$RepoRoot) {
    $modulesRoot = Join-Path $RepoRoot '.bdd/modules'
    if (-not (Test-Path -LiteralPath $modulesRoot -PathType Container)) { return @() }
    @(Get-ChildItem -LiteralPath $modulesRoot -Recurse -File -Filter 'MODULE.md' | Sort-Object FullName | ForEach-Object {
        $errors = @()
        $fm = [ordered]@{}
        try { $fm = Read-ModuleFrontMatter $_.FullName } catch { $errors += $_.Exception.Message }
        [pscustomobject]@{
            name = [IO.Path]::GetRelativePath($modulesRoot, $_.DirectoryName).Replace('\', '/')
            dir = $_.DirectoryName
            modulePath = $_.FullName
            prefix = "$($fm['prefix'])"
            paths = @($fm['paths'] | Where-Object { $_ })
            issues = @($fm['issues'] | Where-Object { $_ })
            removed = @(@($fm['removed']) | Where-Object { $_ } | ForEach-Object { ($_ -split '\s+')[0] })
            errors = $errors
        }
    })
}

<#
.SYNOPSIS
  解析 .feature 檔的情境。標籤取情境標題上方連續的 @ 行；功能層的標籤會在遇到「功能:」時清掉，不算進情境。
  回傳欄位：file、line、title、tags、ids（模組編號，例如 SS-01）、issues（@#單號 的數字）、methods（UI／API／DB）。
#>
function Get-FeatureScenarios([Parameter(Mandatory)][string]$Path) {
    $lines = @(Get-Content -LiteralPath $Path -Encoding utf8)
    $pending = [Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t.StartsWith('@')) {
            foreach ($tag in $t -split '\s+') { if ($tag.StartsWith('@')) { $pending.Add($tag) } }
            continue
        }
        if ($t -match '^(場景大綱|場景|劇本大綱|劇本|Scenario Outline|Scenario)\s*[:：]\s*(.*)$') {
            $tags = @($pending)
            [pscustomobject]@{
                file = $Path
                line = $i + 1
                title = $Matches[2]
                tags = $tags
                ids = @($tags | Where-Object { $_ -cmatch '^@[A-Z]{2,3}-\d+$' } | ForEach-Object { $_.Substring(1) })
                issues = @($tags | Where-Object { $_ -match '^@#\d+$' } | ForEach-Object { $_.Substring(2) })
                methods = @($tags | Where-Object { $_ -cin '@UI', '@API', '@DB' } | ForEach-Object { $_.Substring(1) })
            }
            $pending.Clear()
            continue
        }
        if ($t -and -not $t.StartsWith('#')) { $pending.Clear() }
    }
}

<#
.SYNOPSIS
  檢查模組情境集，回傳問題清單（rule、module、file、line、message）。沒有問題時回傳空陣列。
#>
function Test-BddModules([Parameter(Mandatory)][string]$RepoRoot) {
    $problems = [Collections.Generic.List[object]]::new()
    $add = {
        param($Rule, $Module, $File, $Line, $Message)
        $problems.Add([pscustomobject]@{ rule = $Rule; module = $Module; file = $File; line = $Line; message = $Message })
    }
    $modulesRoot = Join-Path $RepoRoot '.bdd/modules'
    $modules = @(Get-BddModules $RepoRoot)

    foreach ($m in $modules) {
        foreach ($e in $m.errors) { & $add 'module-format' $m.name $m.modulePath $null $e }
        if ($m.errors.Count) { continue }
        if ($m.prefix -cnotmatch '^[A-Z]{2,3}$') { & $add 'module-format' $m.name $m.modulePath $null "前綴必須是 2–3 個大寫英文字母：'$($m.prefix)'" }
        if (-not $m.paths.Count) { & $add 'module-format' $m.name $m.modulePath $null '缺少 paths（對應程式路徑）' }
    }

    foreach ($g in @($modules | Where-Object { $_.prefix } | Group-Object prefix -CaseSensitive | Where-Object Count -gt 1)) {
        & $add 'duplicate-prefix' (($g.Group | ForEach-Object name) -join '、') $null $null "前綴 $($g.Name) 被多個模組使用"
    }

    if (Test-Path -LiteralPath $modulesRoot -PathType Container) {
        $moduleDirs = @($modules | ForEach-Object dir)
        foreach ($f in Get-ChildItem -LiteralPath $modulesRoot -Recurse -File -Filter '*.feature') {
            if ($f.DirectoryName -notin $moduleDirs) {
                & $add 'orphan-feature' $null ([IO.Path]::GetRelativePath($RepoRoot, $f.FullName).Replace('\', '/')) $null '情境檔所在目錄沒有 MODULE.md'
            }
        }
    }

    foreach ($m in $modules) {
        $seen = @{}
        foreach ($f in Get-ChildItem -LiteralPath $m.dir -File -Filter '*.feature' | Sort-Object Name) {
            $rel = [IO.Path]::GetRelativePath($RepoRoot, $f.FullName).Replace('\', '/')
            foreach ($s in @(Get-FeatureScenarios $f.FullName)) {
                if ($s.ids.Count -ne 1) { & $add 'scenario-id' $m.name $rel $s.line "情境必須剛好有一個編號標籤：$($s.title)"; continue }
                $id = $s.ids[0]
                if ($id.Split('-')[0] -cne $m.prefix) { & $add 'unknown-prefix' $m.name $rel $s.line "編號 $id 的前綴不是本模組登記的 $($m.prefix)" }
                if ($seen.ContainsKey($id)) { & $add 'duplicate-id' $m.name $rel $s.line "編號 $id 重複（另見 $($seen[$id])）" }
                else { $seen[$id] = "${rel}:$($s.line)" }
                if ($id -in $m.removed) { & $add 'reused-id' $m.name $rel $s.line "編號 $id 已在 MODULE.md 記為移除，不可再用" }
                if (-not $s.issues.Count) { & $add 'missing-issue-tag' $m.name $rel $s.line "情境缺少單號標籤（例如 @#5349）：$($s.title)" }
                if (-not $s.methods.Count) { & $add 'missing-method-tag' $m.name $rel $s.line "情境缺少 @UI／@API／@DB：$($s.title)" }
            }
        }
    }
    @($problems)
}

<#
.SYNOPSIS
  回傳模組的下一個可用編號：現有與已移除編號的最大號加一，至少兩位數（例如 SS-08）。
#>
function Get-NextScenarioId([Parameter(Mandatory)]$Module) {
    $existing = @(Get-ChildItem -LiteralPath $Module.dir -File -Filter '*.feature' | ForEach-Object { Get-FeatureScenarios $_.FullName } | ForEach-Object { $_.ids })
    $numbers = @(@($existing) + @($Module.removed) | Where-Object { $_ -cmatch "^$([regex]::Escape($Module.prefix))-(\d+)$" } | ForEach-Object { [int]($_ -replace '^.*-', '') })
    $next = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    '{0}-{1:D2}' -f $Module.prefix, [int]$next
}

<#
.SYNOPSIS
  把 glob（支援 **、*、?）轉成比對 repo 相對路徑（以 / 分隔）的正規表示式字串。
#>
function ConvertTo-GlobRegex([Parameter(Mandatory)][string]$Glob) {
    $g = $Glob.Replace('\', '/')
    $sb = [Text.StringBuilder]::new('^')
    for ($i = 0; $i -lt $g.Length; $i++) {
        $c = $g[$i]
        if ($c -eq '*' -and $i + 1 -lt $g.Length -and $g[$i + 1] -eq '*') {
            $i++
            if ($i + 1 -lt $g.Length -and $g[$i + 1] -eq '/') { $i++; [void]$sb.Append('(?:.*/)?') }
            else { [void]$sb.Append('.*') }
        } elseif ($c -eq '*') { [void]$sb.Append('[^/]*') }
        elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
        else { [void]$sb.Append([regex]::Escape([string]$c)) }
    }
    [void]$sb.Append('$')
    $sb.ToString()
}

<#
.SYNOPSIS
  依各 MODULE.md 的 paths 找出異動檔案所屬的模組。.bdd/ 底下的檔案略過。
  回傳 modules（name、files）與 unmatched（沒有任何模組對應的檔案）。
#>
function Find-ModulesForPaths([Parameter(Mandatory)][string]$RepoRoot, [string[]]$Paths = @()) {
    $rules = @(foreach ($m in @(Get-BddModules $RepoRoot | Where-Object { -not $_.errors.Count })) {
        foreach ($glob in $m.paths) { [pscustomobject]@{ module = $m.name; regex = [regex]::new((ConvertTo-GlobRegex $glob), 'IgnoreCase') } }
    })
    $hits = [ordered]@{}
    $unmatched = [Collections.Generic.List[string]]::new()
    foreach ($p in @($Paths | ForEach-Object { $_.Replace('\', '/') -replace '^\./', '' } | Where-Object { $_ } | Sort-Object -Unique)) {
        if ($p.StartsWith('.bdd/')) { continue }
        $matched = @($rules | Where-Object { $_.regex.IsMatch($p) } | ForEach-Object module | Sort-Object -Unique)
        if (-not $matched.Count) { $unmatched.Add($p); continue }
        foreach ($name in $matched) {
            if (-not $hits.Contains($name)) { $hits[$name] = [Collections.Generic.List[string]]::new() }
            $hits[$name].Add($p)
        }
    }
    [pscustomobject]@{
        modules = @($hits.Keys | Sort-Object | ForEach-Object { [pscustomobject]@{ name = $_; files = @($hits[$_]) } })
        unmatched = @($unmatched)
    }
}

Export-ModuleMember -Function *
```

- [ ] **Step 4：實作 `bdd-modules.ps1`**

建立 `skills/bdd-local-test/scripts/bdd-modules.ps1`：

```powershell
<#
.SYNOPSIS
  模組情境集的檢查與查詢：檢查編號規則（-Lint）、取得下一個編號（-NextId）、依異動檔案找出模組（-ForPaths／-Base）。

.DESCRIPTION
  模組放在 <repo>/.bdd/modules/<portal>/<主路由>/，每個模組一份 MODULE.md（front matter 含 prefix、paths、issues、removed）。
  exit code：0 = 通過／查詢成功、1 = -Lint 有問題、2 = 參數或環境錯誤。

.PARAMETER Repo
  repo 或 worktree 路徑，預設目前目錄。

.PARAMETER Lint
  檢查所有模組：前綴、編號重複、已移除編號重用、缺單號或驗證手段標籤、孤兒情境檔、MODULE.md 格式。

.PARAMETER NextId
  回傳 -Module 指定模組的下一個可用編號。

.PARAMETER Module
  模組名稱（相對 .bdd/modules，例如 organizer/schedule-settings）。

.PARAMETER ForPaths
  依這些 repo 相對路徑找出所屬模組。

.PARAMETER Base
  以 git diff <Base>...HEAD 加上未提交異動的檔案找出所屬模組。

.EXAMPLE
  pwsh -NoProfile -File bdd-modules.ps1 -Lint
  pwsh -NoProfile -File bdd-modules.ps1 -NextId -Module organizer/schedule-settings
  pwsh -NoProfile -File bdd-modules.ps1 -Base origin/develop
#>
param(
    [string]$Repo = '.',
    [switch]$Lint,
    [switch]$NextId,
    [string]$Module,
    [string[]]$ForPaths,
    [string]$Base
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddModules.psm1') -Force
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
    $wantPaths = $PSBoundParameters.ContainsKey('ForPaths') -or $PSBoundParameters.ContainsKey('Base')
    if (@(@([bool]$Lint, [bool]$NextId, $wantPaths) | Where-Object { $_ }).Count -ne 1) { throw '請擇一指定 -Lint、-NextId 或 -ForPaths／-Base' }
    $top = git -C (Resolve-Path -LiteralPath $Repo).Path rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $top) { throw "不在 git 工作區內：$Repo" }
    $top = [IO.Path]::GetFullPath(($top | Select-Object -First 1).Trim())

    if ($Lint) {
        $problems = @(Test-BddModules $top)
        [pscustomobject]@{ repo = $top; modules = @(Get-BddModules $top).Count; problems = $problems } | ConvertTo-Json -Depth 4
        exit $(if ($problems.Count) { 1 } else { 0 })
    }

    if ($NextId) {
        if (-not $Module) { throw '-NextId 需要 -Module' }
        $m = Get-BddModules $top | Where-Object { $_.name -eq $Module.Replace('\', '/') } | Select-Object -First 1
        if (-not $m) { throw "找不到模組：$Module" }
        if ($m.errors.Count) { throw "模組的 MODULE.md 有錯誤：$($m.errors -join '；')" }
        [pscustomobject]@{ module = $m.name; prefix = $m.prefix; next = (Get-NextScenarioId $m) } | ConvertTo-Json
        exit 0
    }

    $paths = @($ForPaths | Where-Object { $_ })
    if ($Base) {
        $diff = @(git -C $top diff --name-only "$Base...HEAD")
        if ($LASTEXITCODE -ne 0) { throw "無法取得 $Base...HEAD 的差異" }
        $paths += $diff
        $paths += @(git -C $top diff --name-only HEAD)
        $paths += @(git -C $top ls-files --others --exclude-standard)
    }
    $r = Find-ModulesForPaths -RepoRoot $top -Paths $paths
    [pscustomobject]@{ repo = $top; modules = $r.modules; unmatched = $r.unmatched } | ConvertTo-Json -Depth 4
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
```

- [ ] **Step 5：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddModules.Tests.ps1 -Output Detailed"`
Expected: PASS（全部 It 通過）。另跑一次全部測試，確認既有 31 個仍通過：
`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`

- [ ] **Step 6：Commit**

```bash
git add skills/bdd-local-test/scripts/lib/BddModules.psm1 skills/bdd-local-test/scripts/bdd-modules.ps1 skills/bdd-local-test/tests/BddModules.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 新增模組情境集的解析與編號檢查腳本" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2：驗證紀錄記下本輪跑了哪些模組情境（`bdd-verification.ps1`）

**Files:**
- Modify: `skills/bdd-local-test/scripts/bdd-verification.ps1`（param 區塊、`-Record` 區塊 L111-156、比對區塊 L215-238）
- Test: `skills/bdd-local-test/tests/BddVerification.Tests.ps1`

**Interfaces:**
- Consumes: `Get-FeatureScenarios`（Task 1）。
- Produces:
  - `-Record` 新參數 `-ChangedScenarios <string[]>`、`-RegressionScenarios <string[]>`；每一項是「`<repo 相對路徑>`」或「`<路徑>::<編號>,<編號>`」，也可用 `;` 串多項。
  - `verification.json` 每一輪新增 `scenarios`：`[{ path, blob（受測 HEAD 的 git blob；未提交為 null）, ids[], role（changed|regression）}]`；情境檔也列入 `dirtyPaths` 的檢查。
  - `-Check` 輸出新增 `changedScenarios[]`；情境檔 blob 與目前 HEAD 不同、或受測時未提交，判 `rerun`。

- [ ] **Step 1：寫失敗的測試**

建立 `skills/bdd-local-test/tests/BddVerification.Tests.ps1`：

```powershell
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
        $s[1].ids | Should -Be @('SS-05')
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

    It '新建未提交的情境檔：blob 為 null' {
        Set-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/03.feature') -Encoding utf8 -Value "功能: z`n  @SS-09 @#2 @UI`n  場景: 九`n    當 a"
        $r = Invoke-Verification $t.repo @{ Record = $true; Dir = '.bdd/1-demo'; Base = $t.base; ChangedScenarios = @('.bdd/modules/m/03.feature') }
        $r.json.scenarios[0].blob | Should -BeNullOrEmpty
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
```

> 註：「未提交的情境檔」這個測試裡，檔案在 HEAD 已存在，所以 blob 是 HEAD 的版本（非 null），但工作區有異動，會列入 `dirtyPaths`；`-Check` 因 `dirtyPaths` 判 `rerun`。新建檔才會是 null。

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddVerification.Tests.ps1 -Output Detailed"`
Expected: FAIL，訊息含「找不到符合參數名稱 'ChangedScenarios' 的參數」。

- [ ] **Step 3：修改 `bdd-verification.ps1`**

1. 在 `.PARAMETER Note` 說明之後補參數說明：

```powershell
.PARAMETER ChangedScenarios
  記錄模式：本輪新增或修改的模組情境檔（repo 相對路徑）。每項可寫「<路徑>」或「<路徑>::<編號>,<編號>」，未列編號時取檔內所有情境；可用 ; 串多項。

.PARAMETER RegressionScenarios
  記錄模式：本輪沒有修改、挑來回歸的模組情境檔，格式同 -ChangedScenarios。
```

2. `param(...)` 在 `[string]$Note = '',` 之後加入：

```powershell
    [string[]]$ChangedScenarios = @(),
    [string[]]$RegressionScenarios = @(),
```

3. 在 `$file = Join-Path $Dir 'verification.json'` 之前加入：

```powershell
Import-Module (Join-Path $PSScriptRoot 'lib/BddModules.psm1') -Force
```

4. 在 `function Get-DirtyPaths` 之後加入：

```powershell
# 把 -ChangedScenarios／-RegressionScenarios 的每一項轉成紀錄：path、blob（受測版本的 git blob；該版本沒有此檔為 null）、ids、role
function ConvertTo-ScenarioRecords([string[]]$Entries, [string]$Role, [string]$HeadSha) {
    $root = (git rev-parse --show-toplevel).Trim()
    foreach ($entry in @($Entries | ForEach-Object { $_ -split ';' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $parts = $entry -split '::', 2
        $path = $parts[0].Replace('\', '/') -replace '^\./', ''
        $full = Join-Path $root $path
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "找不到情境檔：$path" }
        $blob = git rev-parse --verify --quiet "${HeadSha}:$path"
        $ids = if ($parts.Count -gt 1) { @($parts[1] -split '[,\s]+' | Where-Object { $_ }) }
               else { @(Get-FeatureScenarios $full | ForEach-Object { $_.ids }) }
        [ordered]@{ path = $path; blob = if ($blob) { "$blob".Trim() } else { $null }; ids = $ids; role = $Role }
    }
}
```

5. `-Record` 區塊：把

```powershell
    $round = [ordered]@{
```

之前插入：

```powershell
    try {
        $scenarioRecords = @(
            ConvertTo-ScenarioRecords $ChangedScenarios 'changed' $headSha
            ConvertTo-ScenarioRecords $RegressionScenarios 'regression' $headSha
        )
    } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
    $scenarioPaths = @($scenarioRecords | ForEach-Object { $_.path })
```

並把 `$round` 內的

```powershell
        dirtyPaths = @(Get-DirtyPaths $paths)
```

改成

```powershell
        dirtyPaths = @(Get-DirtyPaths (@($paths) + $scenarioPaths))
```

在 `files      = $blobs` 之後加一行：

```powershell
        scenarios  = $scenarioRecords
```

6. 比對區塊：把

```powershell
$changedFiles = @($changedFiles)
$dirty = @(Get-DirtyPaths @($last.files.Keys))
```

改成

```powershell
$changedFiles = @($changedFiles)
# 模組情境檔：受測時未提交（blob 為 null）或與目前 HEAD 不同，都要重測
$scenarioList = if ($last.Keys -contains 'scenarios') { @($last.scenarios) } else { @() }
$changedScenarios = @(foreach ($s in $scenarioList) {
    $b = git rev-parse --verify --quiet "${headSha}:$($s.path)"
    $b = if ($b) { "$b".Trim() } else { $null }
    if ($null -eq $s.blob -or $b -ne $s.blob) { $s.path }
})
if ($changedScenarios.Count -gt 0) { $reasons.Add("$($changedScenarios.Count) 個情境檔與受測時不同或受測時未提交：" + ($changedScenarios -join '、')) }
$dirty = @(Get-DirtyPaths (@($last.files.Keys) + @($scenarioList | ForEach-Object { $_.path })))
```

並在最後輸出的 `[ordered]@{ ... }` 加入 `changedScenarios = $changedScenarios`（放在 `changedFiles` 之後）。

7. 檔頭 `.DESCRIPTION` 的比對項目清單加一行：

```
    - 本輪跑過的模組情境檔（scenarios）在目前 HEAD 的 blob 是否與紀錄時相同
```

- [ ] **Step 4：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS（含新測試與既有測試）。

- [ ] **Step 5：Commit**

```bash
git add skills/bdd-local-test/scripts/bdd-verification.ps1 skills/bdd-local-test/tests/BddVerification.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 驗證紀錄記下本輪執行的模組情境並納入重測判斷" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3：無損 WebP 轉檔（`BddImage.psm1`＋`bdd_webp.py`）

**Files:**
- Create: `skills/bdd-local-test/scripts/lib/bdd_webp.py`
- Create: `skills/bdd-local-test/scripts/lib/BddImage.psm1`
- Test: `skills/bdd-local-test/tests/BddImage.Tests.ps1`

**Interfaces:**
- Consumes: 無。
- Produces:
  - `$WebpConvertibleExtensions` = `.png`、`.jpg`、`.jpeg`、`.bmp`（GIF 可能是動畫，不轉）。
  - `Get-WebpEncoder` → `hashtable`：`kind`（`'pillow'` 或 `$null`）、`command`、`prefixArgs`（字串陣列）、`helper`（`bdd_webp.py` 路徑）。環境變數 `BDD_WEBP_ENCODER`＝`auto`（預設）／`pillow`（找不到就丟例外）／`none`。
  - `Convert-ToLosslessWebp -Source <檔> -Destination <檔> -Encoder <hashtable>` → `hashtable`：`ok`（bool）、`reason`（`$null`／`encoder-failed`／`not-identical`／`not-smaller`）、`encoder`、`sourceBytes`、`webpBytes`。`ok` 為 false 時不留下 Destination；不改動 Source。
  - `bdd_webp.py check` 印 `{"ok": true|false}`；`bdd_webp.py convert <src> <dst>` 印 `{"identical": bool, "sourceBytes": n, "webpBytes": n}`，錯誤時印 `{"error": "..."}` 並 exit 1。

- [ ] **Step 1：寫失敗的測試**

建立 `skills/bdd-local-test/tests/BddImage.Tests.ps1`：

```powershell
<#
  無損 WebP 轉檔的 Pester 測試。有支援 WebP 的 Python Pillow 才跑實際轉檔；決策邏輯以假編碼器測試，不需 Python。
#>

BeforeAll {
    $script:Scripts = Join-Path $PSScriptRoot '../scripts'
    Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
    Add-Type -AssemblyName System.Drawing

    $env:BDD_WEBP_ENCODER = $null
    $script:Pillow = Get-WebpEncoder

    # 產生一張 PNG：純色背景，左上角一個完全透明但 RGB 非零的像素
    function New-AlphaPng([string]$Path, [int]$Width = 200, [int]$Height = 100) {
        [IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
        $bmp = [Drawing.Bitmap]::new($Width, $Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::FromArgb(255, 51, 102, 153)); $g.Dispose()
        $bmp.SetPixel(3, 3, [Drawing.Color]::FromArgb(0, 10, 20, 30))
        $bmp.Save($Path, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    }

    # 建立假編碼器：以 pwsh 執行一段腳本，依 Mode 模擬「轉檔結果」
    function New-FakeEncoder([string]$Dir, [ValidateSet('identical-smaller', 'identical-larger', 'different', 'fail')][string]$Mode) {
        $script = Join-Path $Dir "fake-$Mode.ps1"
        $body = switch ($Mode) {
            'identical-smaller' { '[IO.File]::WriteAllBytes($args[2], [byte[]](1,2,3)); ''{"identical": true, "sourceBytes": 0, "webpBytes": 3}''' }
            'identical-larger'  { '[IO.File]::WriteAllBytes($args[2], [byte[]]::new(100000)); ''{"identical": true, "sourceBytes": 0, "webpBytes": 100000}''' }
            'different'         { '[IO.File]::WriteAllBytes($args[2], [byte[]](1,2,3)); ''{"identical": false, "sourceBytes": 0, "webpBytes": 3}''' }
            'fail'              { '''{"error": "boom"}''; exit 1' }
        }
        Set-Content -LiteralPath $script -Value $body -Encoding utf8
        @{ kind = 'pillow'; command = (Get-Process -Id $PID).Path; prefixArgs = @('-NoProfile', '-File'); helper = $script }
    }
}

AfterAll { $env:BDD_WEBP_ENCODER = $null }

Describe 'Get-WebpEncoder' {
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It 'BDD_WEBP_ENCODER=none 時沒有編碼器' {
        $env:BDD_WEBP_ENCODER = 'none'
        (Get-WebpEncoder).kind | Should -BeNullOrEmpty
    }

    It '偵測到的編碼器只會是 pillow 或沒有' {
        $script:Pillow.kind | Should -BeIn @('pillow', $null)
    }
}

Describe 'Convert-ToLosslessWebp（假編碼器）' {
    BeforeEach {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $dir | Out-Null
        $src = Join-Path $dir 'a.png'
        [IO.File]::WriteAllBytes($src, [byte[]]::new(1000))
        $dst = Join-Path $dir 'a.webp'
    }

    It '像素一致且較小時 ok' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'identical-smaller')
        $r.ok | Should -BeTrue
        $r.sourceBytes | Should -Be 1000
        $r.webpBytes | Should -Be 3
        Test-Path -LiteralPath $dst | Should -BeTrue
    }

    It '轉完比原檔大時 not-smaller，且刪除產物' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'identical-larger')
        $r.ok | Should -BeFalse
        $r.reason | Should -Be 'not-smaller'
        Test-Path -LiteralPath $dst | Should -BeFalse
    }

    It '像素不一致時 not-identical，且刪除產物' {
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'different')
        $r.reason | Should -Be 'not-identical'
        Test-Path -LiteralPath $dst | Should -BeFalse
    }

    It '編碼器失敗時 encoder-failed，來源不變' {
        $before = (Get-FileHash -LiteralPath $src).Hash
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder (New-FakeEncoder $dir 'fail')
        $r.reason | Should -Be 'encoder-failed'
        (Get-FileHash -LiteralPath $src).Hash | Should -Be $before
    }

    It '沒有編碼器時丟出例外' {
        { Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder @{ kind = $null } } | Should -Throw '*WebP*'
    }
}

Describe 'Convert-ToLosslessWebp（Pillow）' {
    It '中文與空白檔名、含透明像素的 PNG 轉成無損 WebP，逐像素一致且較小' {
        if ($script:Pillow.kind -ne 'pillow') { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $dir = Join-Path $TestDrive 'pillow'
        $src = Join-Path $dir 'R1_SS-01_列表 首頁.png'
        New-AlphaPng $src
        $dst = Join-Path $dir 'R1_SS-01_列表 首頁.webp'
        $r = Convert-ToLosslessWebp -Source $src -Destination $dst -Encoder $script:Pillow
        $r.ok | Should -BeTrue
        $r.encoder | Should -Be 'pillow'
        $r.webpBytes | Should -BeLessThan $r.sourceBytes
        Test-Path -LiteralPath $dst | Should -BeTrue
    }
}
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddImage.Tests.ps1 -Output Detailed"`
Expected: FAIL，`BddImage.psm1` 找不到。

- [ ] **Step 3：實作 `bdd_webp.py`**

建立 `skills/bdd-local-test/scripts/lib/bdd_webp.py`：

```python
"""bdd-local-test 的 WebP 輔助程式：以 Pillow 做無損轉檔並逐像素驗證。

用法：
  python bdd_webp.py check
      印出 {"ok": true|false}：Pillow 是否支援 WebP。
  python bdd_webp.py convert <來源> <目的地>
      無損轉成 WebP（exact=True 保留透明像素的 RGB），再解碼回 RGBA 與原圖逐位元組比對。
      印出 {"identical": bool, "sourceBytes": n, "webpBytes": n}；失敗時印 {"error": "..."} 並以 1 結束。

輸出一律是 ASCII 跳脫的 JSON，避免 Windows 主控台編碼把中文檔名弄亂。
"""
import json
import os
import sys


def _rgba(path):
    """讀取圖片並轉成 RGBA，回傳已載入的 Image。"""
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        return im.convert("RGBA")


def check():
    """回報 Pillow 是否可用且支援 WebP。"""
    try:
        from PIL import features
        print(json.dumps({"ok": bool(features.check("webp"))}))
    except Exception:  # Pillow 未安裝或載入失敗
        print(json.dumps({"ok": False}))


def convert(src, dst):
    """把 src 無損轉成 dst（WebP），回報是否逐像素一致與前後大小。"""
    original = _rgba(src)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    original.save(dst, "WEBP", lossless=True, quality=100, method=6, exact=True)
    restored = _rgba(dst)
    identical = original.size == restored.size and original.tobytes() == restored.tobytes()
    print(json.dumps({
        "identical": identical,
        "sourceBytes": os.path.getsize(src),
        "webpBytes": os.path.getsize(dst),
    }))


def main(argv):
    """解析命令列並執行對應動作；回傳 exit code。"""
    try:
        if len(argv) == 2 and argv[1] == "check":
            check()
            return 0
        if len(argv) == 4 and argv[1] == "convert":
            convert(argv[2], argv[3])
            return 0
        print(json.dumps({"error": "usage: bdd_webp.py check | convert <src> <dst>"}))
        return 2
    except Exception as exc:  # 任何轉檔錯誤都以 JSON 回報
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4：實作 `BddImage.psm1`**

建立 `skills/bdd-local-test/scripts/lib/BddImage.psm1`：

```powershell
<#
.SYNOPSIS
  BDD 證據截圖的無損 WebP 轉檔：偵測 Pillow、轉檔並逐像素驗證。

.DESCRIPTION
  轉檔與驗證都在 bdd_webp.py（Python Pillow）內完成。沒有 Pillow 時 Get-WebpEncoder 回傳 kind = $null，
  呼叫端應保留原檔並提出警告，不可讓封存失敗。
#>

Set-StrictMode -Version 3.0

<#
.SYNOPSIS
  封存時會嘗試轉成無損 WebP 的副檔名（GIF 可能是動畫，不轉）。
#>
$script:WebpConvertibleExtensions = @('.png', '.jpg', '.jpeg', '.bmp')

# Get-WebpEncoder 的快取：同一個行程內環境變數沒變就不重新偵測
$script:EncoderCache = @{}

<#
.SYNOPSIS
  找出可用的無損 WebP 編碼器（只支援 Python Pillow）。
  環境變數 BDD_WEBP_ENCODER：auto（預設，找不到就回傳 kind = $null）／pillow（找不到就丟例外）／none（不轉檔）。
  回傳 hashtable：kind（'pillow' 或 $null）、command（python 執行檔）、prefixArgs（例如 py 的 -3）、helper（bdd_webp.py）。
#>
function Get-WebpEncoder {
    $want = if ($env:BDD_WEBP_ENCODER) { $env:BDD_WEBP_ENCODER.ToLowerInvariant() } else { 'auto' }
    if ($script:EncoderCache.ContainsKey($want)) { return $script:EncoderCache[$want] }
    $result = @{ kind = $null }
    if ($want -ne 'none') {
        $helper = Join-Path $PSScriptRoot 'bdd_webp.py'
        foreach ($candidate in @(@('python'), @('python3'), @('py', '-3'))) {
            $cmd = Get-Command $candidate[0] -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { continue }
            $prefix = @($candidate | Select-Object -Skip 1)
            $out = & $cmd.Source @prefix $helper check 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
            try { $ok = (($out | Select-Object -Last 1) | ConvertFrom-Json).ok } catch { continue }
            if ($ok) { $result = @{ kind = 'pillow'; command = $cmd.Source; prefixArgs = $prefix; helper = $helper }; break }
        }
        if ($want -eq 'pillow' -and -not $result.kind) { throw 'BDD_WEBP_ENCODER=pillow，但找不到支援 WebP 的 Python Pillow' }
    }
    $script:EncoderCache[$want] = $result
    $result
}

<#
.SYNOPSIS
  把一張圖片轉成無損 WebP 並逐像素驗證；不改動來源檔。
  回傳 hashtable：ok、reason（$null／encoder-failed／not-identical／not-smaller）、encoder、sourceBytes、webpBytes。
  ok 為 false 時刪除 Destination，不留下產物。
#>
function Convert-ToLosslessWebp {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [Parameter(Mandatory)]$Encoder)
    if ($Encoder.kind -ne 'pillow') { throw '沒有可用的 WebP 編碼器（需要支援 WebP 的 Python Pillow）' }
    $sourceBytes = (Get-Item -LiteralPath $Source).Length
    $prefix = @($Encoder.prefixArgs)
    $out = & $Encoder.command @prefix $Encoder.helper convert $Source $Destination 2>$null
    $exit = $LASTEXITCODE
    $result = @{ ok = $false; reason = 'encoder-failed'; encoder = 'pillow'; sourceBytes = $sourceBytes; webpBytes = $null }
    if ($exit -eq 0 -and $out -and (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        $report = $null
        try { $report = ($out | Select-Object -Last 1) | ConvertFrom-Json } catch { $report = $null }
        if ($report -and $report.PSObject.Properties['identical']) {
            $result.webpBytes = (Get-Item -LiteralPath $Destination).Length
            if (-not $report.identical) { $result.reason = 'not-identical' }
            elseif ($result.webpBytes -ge $sourceBytes) { $result.reason = 'not-smaller' }
            else { $result.ok = $true; $result.reason = $null }
        }
    }
    if (-not $result.ok -and (Test-Path -LiteralPath $Destination)) { Remove-Item -LiteralPath $Destination -Force }
    $result
}

Export-ModuleMember -Function * -Variable WebpConvertibleExtensions
```

- [ ] **Step 5：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddImage.Tests.ps1 -Output Detailed"`
Expected: PASS；本機有 Pillow 11.3，「Pillow」那個 It 應實際執行通過（不是 Skipped）。

- [ ] **Step 6：Commit**

```bash
git add skills/bdd-local-test/scripts/lib/bdd_webp.py skills/bdd-local-test/scripts/lib/BddImage.psm1 skills/bdd-local-test/tests/BddImage.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 新增以 Pillow 無損轉 WebP 並逐像素驗證的轉檔模組" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4：抽出封存打包管線（`BddPack.psm1`），`archive-bdd.ps1` 改用它（行為不變）

**Files:**
- Create: `skills/bdd-local-test/scripts/lib/BddPack.psm1`
- Modify: `skills/bdd-local-test/scripts/archive-bdd.ps1`（L119-219：蒐集、去重、打包、驗證）
- Test: `skills/bdd-local-test/tests/BddPack.Tests.ps1`

**Interfaces:**
- Consumes: `Get-Sha256Hex`、`$PrecompressedExtensions`（`BddArchive.psm1`）。
- Produces:
  - `New-PackEntry -Relative <封存內相對路徑> -Path <實體檔> [-Extra <OrderedDictionary>]` → `pscustomobject`：`relative`、`path`、`sha256`、`size`、`lastWrite`（DateTime，可改寫）、`extra`（OrderedDictionary，會原樣寫進 manifest 的該檔紀錄）。
  - `Get-DedupPlan -Entries <PackEntry[]>` → `pscustomobject`：`stored`（PackEntry[]，每種內容一份）、`aliases`（OrderedDictionary：alias → canonical）、`files`（OrderedDictionary：relative → `{ sha256, size, ...extra }`）。
  - `Write-BddZip -Stored <PackEntry[]> -Prefix <"topic/"> -ManifestJson <字串> -Target <zip 路徑>`：Target 已存在就丟例外；先寫暫存檔、逐檔驗證 SHA-256 與數量，通過才搬到 Target；失敗不留半成品。
  - 常數 `$ManifestName` = `bdd-manifest.json`。

- [ ] **Step 1：寫失敗的測試**

建立 `skills/bdd-local-test/tests/BddPack.Tests.ps1`：

```powershell
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
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddPack.Tests.ps1 -Output Detailed"`
Expected: FAIL，`BddPack.psm1` 找不到。

- [ ] **Step 3：實作 `BddPack.psm1`（這一步只放 Task 4 需要的三個函式）**

建立 `skills/bdd-local-test/scripts/lib/BddPack.psm1`：

```powershell
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
```

- [ ] **Step 4：`archive-bdd.ps1` 改用打包管線**

1. 在 `Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force` 之後加入：

```powershell
Import-Module (Join-Path $PSScriptRoot 'lib/BddPack.psm1') -Force
```

並刪除 `$manifestName = 'bdd-manifest.json'` 這一行，改用模組的 `$ManifestName`（L68 的檢查改為 `Join-Path $source $ManifestName`、訊息改為 `"輸出目錄不可自帶 $ManifestName（封存時會產生）"`）。

2. 把「# 3. 蒐集與去重」整段（L119-137）換成：

```powershell
# 3. 蒐集（舊 evidence.zip 已攤平，不再收入）
$entries = @(Get-ChildItem -LiteralPath $source -Recurse -File -Force |
    Where-Object { -not ($_.FullName.Equals($legacyZip, [StringComparison]::OrdinalIgnoreCase)) } |
    ForEach-Object { New-PackEntry -Relative ([IO.Path]::GetRelativePath($source, $_.FullName)) -Path $_.FullName })
$sourceFileCount = $entries.Count
```

3. 在「# 5. 決定封存位置」之前加入去重：

```powershell
$plan = Get-DedupPlan $entries
```

4. `$manifest` 的欄位改為：`sourceFileCount = $sourceFileCount`、`storedFileCount = $plan.stored.Count`、`files = $plan.files`、`aliases = $plan.aliases`（其他欄位不變，`schema` 先維持 1，Task 6 再升到 2）。

5. 把「# 6. 打包到暫存檔、驗證後再搬到正式位置」整段（L179-219）換成：

```powershell
# 6. 打包、驗證後才搬到正式位置（失敗不留半成品）
Write-BddZip -Stored $plan.stored -Prefix "$topic/" -ManifestJson $manifestJson -Target $target
```

並刪除 L158 的 `if (Test-Path -LiteralPath $target) { throw ... }`（已由 `Write-BddZip` 檢查）。

6. 輸出段的 `fileCount = $files.Count` 改 `fileCount = $sourceFileCount`、`storedFileCount = $stored.Count` 改 `$plan.stored.Count`、`aliasCount = $aliases.Count` 改 `$plan.aliases.Count`、`sourceBytes` 改為：

```powershell
    sourceBytes = [long](($entries | ForEach-Object { $_.size } | Measure-Object -Sum).Sum)
```

- [ ] **Step 5：執行全部測試，確認行為不變**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS；`BddArchive.Tests.ps1` 原有 31 個全部通過（重構不改行為），`BddPack.Tests.ps1` 3 個通過。

- [ ] **Step 6：Commit**

```bash
git add skills/bdd-local-test/scripts/lib/BddPack.psm1 skills/bdd-local-test/scripts/archive-bdd.ps1 skills/bdd-local-test/tests/BddPack.Tests.ps1
git commit -m "#0000 refactor(bdd-local-test): 將封存的去重、打包與驗證抽成共用模組" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5：封存時放入受測當時的模組情境快照

**Files:**
- Modify: `skills/bdd-local-test/scripts/lib/BddArchive.psm1`（新增 `Save-GitBlob`）
- Modify: `skills/bdd-local-test/scripts/lib/BddPack.psm1`（新增 `Get-ScenarioSnapshotEntries`）
- Modify: `skills/bdd-local-test/scripts/archive-bdd.ps1`（L61-68 的必要檔檢查、蒐集之後加入快照、manifest 加 `features`）
- Test: `skills/bdd-local-test/tests/BddArchive.Tests.ps1`（新增 Describe「情境快照」）

**Interfaces:**
- Consumes: `New-PackEntry`（Task 4）、`verification.json` 的 `scenarios`（Task 2）。
- Produces:
  - `Save-GitBlob -Repo <repo> -Blob <sha> -Destination <檔>`：以二進位原樣寫出 blob 內容；失敗丟例外且不留檔。
  - `Get-ScenarioSnapshotEntries -RepoRoot <repo> -Commit <sha> -Scenarios <紀錄[]> -Staging <暫存目錄>` → PackEntry[]，`relative` = `features/<去掉 .bdd/modules/ 的路徑>`，`extra` = `{ scenarioPath, blob, role }`。blob 為 null、或與 `<Commit>:<path>` 不同時丟例外。
  - manifest 新增 `features`：快照的情境檔 repo 相對路徑陣列。

- [ ] **Step 1：寫失敗的測試**

在 `BddArchive.Tests.ps1` 的 `BeforeAll` 內，`Read-Manifest` 之後加入輔助函式：

```powershell
    # 把 repo 改成模組情境格式：情境移到 .bdd/modules/m/01.feature 並 commit，verification.json 記錄 scenarios；回傳新的 head 與 blob
    function Convert-ToModuleLayout([hashtable]$T, [switch]$KeepIssueFeature) {
        $mod = Join-Path $T.repo '.bdd/modules/m'
        New-Item -ItemType Directory -Path $mod -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $mod 'MODULE.md') -Encoding utf8 -Value @('---', 'prefix: DM', 'paths:', '  - src/**', '---')
        Set-Content -LiteralPath (Join-Path $mod '01.feature') -Encoding utf8 -Value "功能: 示範`n  @DM-01 @#1234 @UI`n  場景: 首頁`n    當 a"
        git -C $T.repo add .bdd/modules ; git -C $T.repo commit -q -m scenarios
        if (-not $KeepIssueFeature) { Remove-Item -LiteralPath (Join-Path $T.bdd '01-demo.feature') }
        $head = (git -C $T.repo rev-parse HEAD).Trim()
        $blob = (git -C $T.repo rev-parse 'HEAD:.bdd/modules/m/01.feature').Trim()
        $doc = @{ rounds = @(@{ head = $head; scenarios = @(@{ path = '.bdd/modules/m/01.feature'; blob = $blob; ids = @('DM-01'); role = 'changed' }) }) }
        Set-Content -LiteralPath (Join-Path $T.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        @{ head = $head; blob = $blob }
    }
```

在檔案末尾新增：

```powershell
Describe 'archive-bdd.ps1 情境快照' {
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $env:BDD_WEBP_ENCODER = 'none'
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It 'issue 資料夾沒有 .feature 時，依 scenarios 收入受測當時的情境' {
        $m = Convert-ToModuleLayout $t
        # 受測之後模組情境又被改過：封存要收的是受測當時那一版
        Add-Content -LiteralPath (Join-Path $t.repo '.bdd/modules/m/01.feature') -Value '  # 之後的修改'
        git -C $t.repo commit -qam later
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }

        $manifest = Read-Manifest $r.archive
        @($manifest.features) | Should -Be @('.bdd/modules/m/01.feature')
        $manifest.files.'features/m/01.feature'.blob | Should -Be $m.blob
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/features/m/01.feature').Open())
            try { $reader.ReadToEnd() | Should -Not -Match '之後的修改' } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
    }

    It '受測時情境檔未提交（blob 為 null）時拒絕封存' {
        Convert-ToModuleLayout $t | Out-Null
        $doc = Get-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
        $doc.rounds[0].scenarios[0].blob = $null
        Set-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*尚未提交*'
    }

    It '紀錄的 blob 與受測 commit 不符時拒絕封存' {
        Convert-ToModuleLayout $t | Out-Null
        $doc = Get-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
        $doc.rounds[0].scenarios[0].blob = '0000000000000000000000000000000000000000'
        Set-Content -LiteralPath (Join-Path $t.bdd 'verification.json') -Value ($doc | ConvertTo-Json -Depth 6) -Encoding utf8
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*不符*'
    }

    It '沒有 .feature 也沒有 scenarios 時拒絕封存' {
        Remove-Item -LiteralPath (Join-Path $t.bdd '01-demo.feature')
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*情境*'
    }

    It '舊格式（issue 資料夾內有 .feature、沒有 scenarios）照舊封存，features 為空' {
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        @((Read-Manifest $r.archive).features).Count | Should -Be 0
    }
}
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddArchive.Tests.ps1 -Output Detailed"`
Expected: 「情境快照」的 5 個 It 中，前 4 個 FAIL（例如「缺少 .feature 情境檔，不能封存」或 manifest 沒有 features）。

- [ ] **Step 3：`BddArchive.psm1` 新增 `Save-GitBlob`**

加在 `Get-RepoTopLevel` 之後：

```powershell
<#
.SYNOPSIS
  把 git blob 的內容以二進位原樣寫到 Destination（不經 PowerShell 管線，避免換行與編碼被改動）。失敗時丟例外且不留檔。
#>
function Save-GitBlob([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string]$Blob, [Parameter(Mandatory)][string]$Destination) {
    [IO.Directory]::CreateDirectory((Split-Path $Destination -Parent)) | Out-Null
    $psi = [Diagnostics.ProcessStartInfo]::new('git')
    foreach ($a in @('-C', $Repo, 'cat-file', 'blob', $Blob)) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($psi)
    $out = [IO.File]::Create($Destination)
    try { $process.StandardOutput.BaseStream.CopyTo($out) } finally { $out.Dispose() }
    $err = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "無法取出 git blob $Blob：$err"
    }
}
```

- [ ] **Step 4：`BddPack.psm1` 新增 `Get-ScenarioSnapshotEntries`**

加在 `Get-DedupPlan` 之前：

```powershell
<#
.SYNOPSIS
  依 verification.json 的 scenarios，取出受測 commit 當時的模組情境檔放進暫存目錄，回傳對應的封存項目。
  封存內路徑為 features/<去掉 .bdd/modules/ 的路徑>；extra 記錄 scenarioPath、blob、role。
  紀錄的 blob 為 null（受測時未提交）或與 <Commit>:<path> 不同時丟例外。
#>
function Get-ScenarioSnapshotEntries {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Commit,
        [object[]]$Scenarios = @(),
        [Parameter(Mandatory)][string]$Staging
    )
    foreach ($s in $Scenarios) {
        if (-not $s.blob) { throw "情境檔受測時尚未提交，無法取出受測版本：$($s.path)；請 commit 後重新以 bdd-verification.ps1 -Record 記錄" }
        $actual = git -C $RepoRoot rev-parse --verify --quiet "${Commit}:$($s.path)"
        if (-not $actual -or "$actual".Trim() -ne $s.blob) { throw "情境檔在受測 commit $Commit 的版本與紀錄不符：$($s.path)" }
        $relative = 'features/' + ($s.path.Replace('\', '/') -replace '^\.bdd/modules/', '')
        $destination = Join-Path $Staging $relative
        Save-GitBlob -Repo $RepoRoot -Blob $s.blob -Destination $destination
        New-PackEntry -Relative $relative -Path $destination -Extra ([ordered]@{ scenarioPath = $s.path; blob = $s.blob; role = $s.role })
    }
}
```

- [ ] **Step 5：`archive-bdd.ps1` 收入情境快照**

1. 把 L67 的

```powershell
if (-not @(Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.feature').Count) { throw '缺少 .feature 情境檔，不能封存' }
```

刪除，改為在必要檔檢查（L61-63）之後讀出最後一輪紀錄：

```powershell
# 讀取最後一輪驗證紀錄：受測版本與本輪執行的模組情境
$verification = Get-Content -LiteralPath (Join-Path $source 'verification.json') -Raw -Encoding utf8 | ConvertFrom-Json
$rounds = @(Get-ConfigValue $verification 'rounds' @())
$lastRound = if ($rounds.Count) { $rounds[-1] } else { $null }
$scenarios = @(Get-ConfigValue $lastRound 'scenarios' @())
$hasIssueFeature = [bool]@(Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.feature').Count
if (-not $hasIssueFeature -and -not $scenarios.Count) { throw '缺少情境：輸出資料夾沒有 .feature，verification.json 最後一輪也沒有 scenarios，不能封存' }
```

2. 「# 4. 受測版本與單號」改用 `$lastRound`：

```powershell
if (-not $Commit) {
    if (-not $lastRound -or -not (Get-ConfigValue $lastRound 'head')) { throw 'verification.json 沒有任何輪次的 head，請以 -Commit 指定受測 SHA' }
    $Commit = $lastRound.head
}
```

並把這段「# 4.」整段移到「# 3. 蒐集」之前（快照需要 `$Commit`）。

3. 在「# 3. 蒐集」之後、`$sourceFileCount` 之前加入快照，整個後續流程包在 `try/finally` 裡以清除暫存目錄：

```powershell
$staging = Join-Path ([IO.Path]::GetTempPath()) ('bdd-archive-' + [IO.Path]::GetRandomFileName())
[IO.Directory]::CreateDirectory($staging) | Out-Null
try {
    # 3-1. 模組情境快照：取受測 commit 當時的版本；輸出資料夾已有同路徑同內容（例如從封存還原）就不重複收
    $existing = @{}
    foreach ($e in $entries) { $existing[$e.relative] = $e }
    foreach ($snap in @(Get-ScenarioSnapshotEntries -RepoRoot $repoRoot -Commit $Commit -Scenarios $scenarios -Staging $staging)) {
        if ($existing.ContainsKey($snap.relative)) {
            if ($existing[$snap.relative].sha256 -ne $snap.sha256) { throw "輸出資料夾已有 $($snap.relative)，但內容與受測 commit 的情境不同，請人工確認" }
            continue
        }
        $entries += $snap
    }
```

`try` 的結尾放在輸出 JSON 之後：

```powershell
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
```

（`$sourceFileCount = $entries.Count` 移到快照之前，代表輸出資料夾原有的檔案數。）

4. `$manifest` 加入欄位（放在 `commit` 之後）：

```powershell
    features = @($scenarios | ForEach-Object { $_.path })
```

- [ ] **Step 6：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS（含原有 31 個）。

- [ ] **Step 7：Commit**

```bash
git add skills/bdd-local-test/scripts/lib/BddArchive.psm1 skills/bdd-local-test/scripts/lib/BddPack.psm1 skills/bdd-local-test/scripts/archive-bdd.ps1 skills/bdd-local-test/tests/BddArchive.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 封存時收入受測當時的模組情境快照" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6：封存時把截圖轉成無損 WebP，並改寫報告連結與遮罩紀錄

**Files:**
- Modify: `skills/bdd-local-test/scripts/lib/BddPack.psm1`（新增 `Convert-PackEntriesToWebp`、`ConvertTo-UrlPath`、`Update-PackMarkdownLinks`、`Update-PackMaskLedger`）
- Modify: `skills/bdd-local-test/scripts/archive-bdd.ps1`（快照之後、去重之前加入轉檔；manifest 升 schema 2；輸出與索引加 webp 欄位）
- Modify: `skills/bdd-local-test/scripts/lib/BddArchive.psm1`（`Get-BddConfig` 不變；新增 `Get-WebpSetting`）
- Test: `skills/bdd-local-test/tests/BddArchive.Tests.ps1`（新增 Describe「WebP」）

**Interfaces:**
- Consumes: `Get-WebpEncoder`、`Convert-ToLosslessWebp`、`$WebpConvertibleExtensions`（Task 3）；`New-PackEntry`、`Get-DedupPlan`（Task 4）。
- Produces:
  - `Get-WebpSetting -ConfigData <config.data>` → `'auto'` 或 `'off'`（`.bdd/config.json` 的 `webp`，預設 `auto`；其他值丟例外）。
  - `Convert-PackEntriesToWebp -Entries <PackEntry[]> -Encoder <hashtable> -Staging <目錄>` → `pscustomobject`：`entries`（轉檔後的完整清單）、`converted[]`（`from`、`to`、`sourceBytes`、`webpBytes`）、`skipped[]`（`file`、`reason`：`not-identical`／`not-smaller`／`encoder-failed`／`name-conflict`）。只處理 `evidence/` 底下 `$WebpConvertibleExtensions` 的檔案；同內容只轉一次。轉成功的項目 `extra` 加 `originalName`、`originalSha256`、`encoder`、`lossless = $true`。
  - `Update-PackMarkdownLinks -Entries -Converted -Staging` → `pscustomobject`：`entries`、`rewritten`（OrderedDictionary：md 檔 → 取代次數）。同時取代原字串與逐段 URL 編碼的字串。
  - `Update-PackMaskLedger -Entries -Converted -Staging` → PackEntry[]；`masking.json` 的鍵改成 `.webp`、`sha256` 改成 WebP 的雜湊，加 `derivedFrom = { name, sha256 }`。
  - manifest：`schema = 2`、`webp = { encoder, converted, skipped[], savedBytes }`、`rewrittenLinks`。
  - 輸出 JSON 新增 `webpEncoder`、`webpConverted`、`webpSavedBytes`；索引 `created` 事件新增 `webp`（bool）。

- [ ] **Step 1：寫失敗的測試**

在 `BddArchive.Tests.ps1` 末尾新增：

```powershell
Describe 'archive-bdd.ps1 WebP' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'
    }
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $env:BDD_WEBP_ENCODER = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }
    AfterEach { $env:BDD_WEBP_ENCODER = $null }

    It '截圖轉成無損 WebP：manifest 記錄原檔，同內容仍去重，ZIP 內沒有 PNG' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpEncoder | Should -Be 'pillow'
        $r.webpConverted | Should -Be 3
        $manifest = Read-Manifest $r.archive
        $manifest.schema | Should -Be 2
        $rec = $manifest.files.'evidence/R1_DM-01_首頁.webp'
        $rec.originalName | Should -Be 'evidence/R1_DM-01_首頁.png'
        $rec.originalSha256 | Should -Be (Get-FileHash -LiteralPath (Join-Path $t.bdd 'evidence/R1_DM-01_首頁.png') -Algorithm SHA256).Hash
        $rec.lossless | Should -BeTrue
        $manifest.aliases.'evidence/R2_DM-01_首頁.webp' | Should -Be 'evidence/R1_DM-01_首頁.webp'
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try { @($zip.Entries.FullName | Where-Object { $_ -like '*.png' }).Count | Should -Be 0 } finally { $zip.Dispose() }
        # 工作區原檔不動
        Test-Path -LiteralPath (Join-Path $t.bdd 'evidence/R1_DM-01_首頁.png') | Should -BeTrue
    }

    It '封存內的 masking.json 改以 WebP 為鍵並保留 derivedFrom' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/masking.json').Open())
            try { $ledger = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
        $rec = $ledger.files.'evidence/R2_DM-02_列表.webp'
        $rec.method | Should -Be 'exempt'
        $rec.sha256 | Should -Be (Read-Manifest $r.archive).files.'evidence/R2_DM-02_列表.webp'.sha256
        $rec.derivedFrom.name | Should -Be 'evidence/R2_DM-02_列表.png'
        $ledger.files.PSObject.Properties.Name | Should -Not -Contain 'evidence/R2_DM-02_列表.png'
    }

    It 'REPORT.md 的連結（含 URL 編碼的中文檔名）改寫成 .webp' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        $encoded = 'evidence/' + [Uri]::EscapeDataString('R2_DM-02_列表.png')
        Set-Content -LiteralPath (Join-Path $t.bdd 'REPORT.md') -Encoding utf8 -Value "# 報告`n![](evidence/R1_DM-01_首頁.png)`n![]($encoded)"
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $zip = [IO.Compression.ZipFile]::OpenRead($r.archive)
        try {
            $reader = [IO.StreamReader]::new($zip.GetEntry('1234-demo/REPORT.md').Open())
            try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $zip.Dispose() }
        $text | Should -Match ([regex]::Escape('evidence/R1_DM-01_首頁.webp'))
        $text | Should -Match ([regex]::Escape('evidence/' + [Uri]::EscapeDataString('R2_DM-02_列表.webp')))
        $text | Should -Not -Match '\.png'
        (Read-Manifest $r.archive).rewrittenLinks.'REPORT.md' | Should -Be 2
        # 工作區報告不動
        Get-Content -LiteralPath (Join-Path $t.bdd 'REPORT.md') -Raw | Should -Match '\.png'
    }

    It '同名不同副檔名時，第二個保留原格式並記錄 name-conflict' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        # 用未壓縮的 BMP：轉 WebP 一定變小，且檔名排序在 .png 之前，先取得 .webp 名稱
        $other = Join-Path $t.bdd 'evidence/R2_DM-02_列表.bmp'
        $bmp = [Drawing.Bitmap]::new(40, 20); $g = [Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::Olive); $g.Dispose()
        $bmp.Save($other, [Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $manifest = Read-Manifest $r.archive
        @($manifest.webp.skipped | Where-Object reason -eq 'name-conflict').Count | Should -Be 1
        $names = @($manifest.files.PSObject.Properties.Name)
        $names | Should -Contain 'evidence/R2_DM-02_列表.webp'
        (@($names | Where-Object { $_ -like 'evidence/R2_DM-02_列表.*' })).Count | Should -Be 2
    }

    It '沒有編碼器時保留原格式並警告 webpUnavailable' {
        $env:BDD_WEBP_ENCODER = 'none'
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpConverted | Should -Be 0
        @($r.warnings) -join ' ' | Should -Match 'webpUnavailable'
        (Read-Manifest $r.archive).files.PSObject.Properties.Name | Should -Contain 'evidence/R1_DM-01_首頁.png'
        $created = Get-Content -LiteralPath (Join-Path $archiveRoot 'index.jsonl') | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -eq 'created'
        $created.webp | Should -BeFalse
    }

    It '.bdd/config.json 設 webp = off 時不轉檔也不警告' {
        Set-BddConfig $t.repo @{ webp = 'off' }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $r.webpConverted | Should -Be 0
        @($r.warnings) -join ' ' | Should -Not -Match 'webpUnavailable'
    }

    It '.bdd/config.json 的 webp 值不合法時拒絕' {
        Set-BddConfig $t.repo @{ webp = 'lossy' }
        Register-AllExempt $t.bdd
        { Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot } } | Should -Throw '*webp*'
    }
}
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddArchive.Tests.ps1 -Output Detailed"`
Expected: 「WebP」的 7 個 It FAIL（輸出沒有 `webpEncoder`／`webpConverted`）。

- [ ] **Step 3：`BddArchive.psm1` 新增 `Get-WebpSetting`**

加在 `Get-MaskConfig` 之後：

```powershell
<#
.SYNOPSIS
  取得 .bdd/config.json 的 webp 設定：auto（預設，有 Pillow 就轉無損 WebP）或 off（不轉）。其他值丟例外。
#>
function Get-WebpSetting($ConfigData) {
    $value = "$(Get-ConfigValue $ConfigData 'webp' 'auto')".ToLowerInvariant()
    if ($value -notin 'auto', 'off') { throw ".bdd/config.json 的 webp 只能是 auto 或 off：$value" }
    $value
}
```

- [ ] **Step 4：`BddPack.psm1` 新增轉檔與改寫函式**

加在 `Get-DedupPlan` 之前：

```powershell
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
    $bySha = @{}
    foreach ($e in @($Entries | Sort-Object -Property relative -CaseSensitive)) {
        $ext = [IO.Path]::GetExtension($e.relative).ToLowerInvariant()
        if (-not $e.relative.StartsWith('evidence/', [StringComparison]::OrdinalIgnoreCase) -or $WebpConvertibleExtensions -notcontains $ext) {
            $result.Add($e); continue
        }
        $webpName = [IO.Path]::ChangeExtension($e.relative, '.webp').Replace('\', '/')
        if ($names.Contains($webpName)) {
            $skipped.Add([pscustomobject]@{ file = $e.relative; reason = 'name-conflict' }); $result.Add($e); continue
        }
        if (-not $bySha.ContainsKey($e.sha256)) {
            $destination = Join-Path $Staging "webp/$($e.sha256).webp"
            $outcome = Convert-ToLosslessWebp -Source $e.path -Destination $destination -Encoder $Encoder
            $outcome.path = $destination
            $bySha[$e.sha256] = $outcome
        }
        $c = $bySha[$e.sha256]
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
    [pscustomobject]@{ entries = @($result); converted = @($converted); skipped = @($skipped) }
}

<#
.SYNOPSIS
  把相對路徑逐段做 URL 編碼（Markdown 連結常見的中文檔名寫法）。
#>
function ConvertTo-UrlPath([Parameter(Mandatory)][string]$Relative) {
    ($Relative -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
}

<#
.SYNOPSIS
  把封存內 .md 檔裡指向已轉檔截圖的連結改成 .webp（原字串與 URL 編碼的字串都換）；改寫後的檔放暫存目錄，工作區不動。
  回傳 entries 與 rewritten（md 檔 → 取代次數）。
#>
function Update-PackMarkdownLinks {
    param([Parameter(Mandatory)][object[]]$Entries, [object[]]$Converted = @(), [Parameter(Mandatory)][string]$Staging)
    $rewritten = [ordered]@{}
    if (-not $Converted.Count) { return [pscustomobject]@{ entries = $Entries; rewritten = $rewritten } }
    $pairs = [Collections.Generic.List[object]]::new()
    foreach ($c in $Converted) {
        $pairs.Add(@($c.from, $c.to))
        $encodedFrom = ConvertTo-UrlPath $c.from
        if ($encodedFrom -ne $c.from) { $pairs.Add(@($encodedFrom, (ConvertTo-UrlPath $c.to))) }
    }
    $out = foreach ($e in $Entries) {
        if ([IO.Path]::GetExtension($e.relative) -ine '.md') { $e; continue }
        $text = [IO.File]::ReadAllText($e.path, [Text.Encoding]::UTF8)
        $count = 0
        foreach ($p in $pairs) {
            $n = [regex]::Matches($text, [regex]::Escape($p[0])).Count
            if ($n) { $text = $text.Replace($p[0], $p[1]); $count += $n }
        }
        if (-not $count) { $e; continue }
        $destination = Join-Path $Staging "md/$($e.relative)"
        [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
        [IO.File]::WriteAllText($destination, $text, [Text.UTF8Encoding]::new($false))
        $rewritten[$e.relative] = $count
        $new = New-PackEntry -Relative $e.relative -Path $destination -Extra $e.extra
        $new.lastWrite = $e.lastWrite
        $new
    }
    [pscustomobject]@{ entries = @($out); rewritten = $rewritten }
}

<#
.SYNOPSIS
  把封存內 masking.json 的遮罩登記改到轉檔後的 .webp：鍵改名、sha256 改成 WebP 的雜湊、加 derivedFrom（原檔名與原雜湊）。
  沒有 masking.json 或沒有轉檔時原樣回傳。
#>
function Update-PackMaskLedger {
    param([Parameter(Mandatory)][object[]]$Entries, [object[]]$Converted = @(), [Parameter(Mandatory)][string]$Staging)
    $ledgerEntry = $Entries | Where-Object { $_.relative -eq 'masking.json' } | Select-Object -First 1
    if (-not $ledgerEntry -or -not $Converted.Count) { return $Entries }
    $data = [IO.File]::ReadAllText($ledgerEntry.path, [Text.Encoding]::UTF8) | ConvertFrom-Json -AsHashtable
    $files = if ($data.ContainsKey('files') -and $data.files) { $data.files } else { [ordered]@{} }
    $byName = @{}
    foreach ($e in $Entries) { $byName[$e.relative] = $e }
    foreach ($c in $Converted) {
        if (-not $files.Contains($c.from)) { continue }
        $old = $files[$c.from]
        $record = [ordered]@{}
        foreach ($k in $old.Keys) { $record[$k] = $old[$k] }
        $record.sha256 = $byName[$c.to].sha256
        $record.derivedFrom = [ordered]@{ name = $c.from; sha256 = $old.sha256 }
        $files.Remove($c.from)
        $files[$c.to] = $record
    }
    $sorted = [ordered]@{}
    foreach ($k in @($files.Keys | Sort-Object { $_ } -CaseSensitive)) { $sorted[$k] = $files[$k] }
    $destination = Join-Path $Staging 'mask/masking.json'
    [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
    [IO.File]::WriteAllText($destination, (([ordered]@{ files = $sorted }) | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
    @($Entries | ForEach-Object {
        if ($_.relative -ne 'masking.json') { $_; return }
        $n = New-PackEntry -Relative 'masking.json' -Path $destination -Extra $_.extra
        $n.lastWrite = $_.lastWrite
        $n
    })
}
```

- [ ] **Step 5：`archive-bdd.ps1` 加入轉檔**

1. 在 `$config = Get-BddConfig $source` 之後（遮罩檢查區塊）加入：

```powershell
$webpSetting = Get-WebpSetting $config.data
```

（`Get-WebpSetting` 丟例外時封存直接失敗，符合「值不合法時拒絕」。）

2. 在情境快照迴圈之後、`$plan = Get-DedupPlan $entries` 之前加入：

```powershell
    # 3-2. 截圖轉無損 WebP（遮罩檢查已對原圖做過）；接著改寫封存內的遮罩紀錄與報告連結
    $encoder = if ($webpSetting -eq 'off') { @{ kind = $null } } else { Get-WebpEncoder }
    $webp = [pscustomobject]@{ entries = $entries; converted = @(); skipped = @() }
    if ($encoder.kind) { $webp = Convert-PackEntriesToWebp -Entries $entries -Encoder $encoder -Staging $staging }
    elseif ($webpSetting -eq 'auto') { $warnings += 'webpUnavailable：找不到支援 WebP 的 Python Pillow，截圖保留原格式；安裝 Pillow 後可用 recompress-bdd.ps1 重新壓縮' }
    $entries = Update-PackMaskLedger -Entries $webp.entries -Converted $webp.converted -Staging $staging
    $links = Update-PackMarkdownLinks -Entries $entries -Converted $webp.converted -Staging $staging
    $entries = $links.entries
    $webpSaved = [long](($webp.converted | ForEach-Object { $_.sourceBytes - $_.webpBytes } | Measure-Object -Sum).Sum)
```

（`$warnings` 目前在「# 5.」才初始化；把 `$warnings = @(...)` 改成先在檔案前段以 `$warnings = @()` 初始化，「# 5.」改為 `$warnings += @(Assert-OutsideRepoWorktrees ...)`。）

3. `$manifest` 改 `schema = 2`，並在 `aliases` 之前加入：

```powershell
    webp = [ordered]@{
        encoder = $encoder.kind
        converted = @($webp.converted).Count
        skipped = @($webp.skipped)
        savedBytes = $webpSaved
    }
    rewrittenLinks = $links.rewritten
```

`$manifestJson = $manifest | ConvertTo-Json -Depth 6` 改 `-Depth 8`。

4. 索引 `created` 事件加入 `webp = [bool]@($webp.converted).Count`。

5. 輸出 JSON 加入：

```powershell
    webpEncoder = $encoder.kind
    webpConverted = @($webp.converted).Count
    webpSavedBytes = $webpSaved
```

6. 檔頭 `.DESCRIPTION` 的流程改為：「攤平舊 evidence.zip → 檢查圖片都已遮罩 → 收入受測當時的模組情境 → 截圖轉無損 WebP（有 Pillow 時）並改寫封存內的遮罩紀錄與報告連結 → 依內容去重 → 打包並寫入 bdd-manifest.json → 逐檔驗證 SHA-256 → 搬到封存庫 → 在 index.jsonl 追加 created 事件，並把同主題的舊封存標為 superseded。」

- [ ] **Step 6：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS。原有測試裡檢查 `fileCount`／`aliasCount`／`storedFileCount` 的 It（`封存時去重、寫入 manifest 與索引...`）在本機有 Pillow 時數字不變（轉檔不改變檔案數；R1／R2 同內容仍去重為 1 個 alias）。若該 It 檢查了 `.png` 項目名稱而失敗，在它的 `BeforeEach` 設 `$env:BDD_WEBP_ENCODER = 'none'`，讓既有測試聚焦在原本的規則。

- [ ] **Step 7：Commit**

```bash
git add skills/bdd-local-test/scripts/lib/BddArchive.psm1 skills/bdd-local-test/scripts/lib/BddPack.psm1 skills/bdd-local-test/scripts/archive-bdd.ps1 skills/bdd-local-test/tests/BddArchive.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 封存時截圖轉無損 WebP 並改寫報告連結與遮罩紀錄" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7：清理比對原檔雜湊，還原後可再封存

**Files:**
- Modify: `skills/bdd-local-test/scripts/prune-bdd.ps1`（`Get-ManifestHashes`，L147-156）
- Test: `skills/bdd-local-test/tests/BddArchive.Tests.ps1`（新增 Describe「WebP 封存的清理與還原」）

**Interfaces:**
- Consumes: Task 6 的 manifest `originalSha256`。
- Produces: `prune-bdd.ps1` 把 manifest 每個檔案的 `sha256` 與 `originalSha256` 都當作「已收錄的內容」。

- [ ] **Step 1：寫失敗的測試**

在 `BddArchive.Tests.ps1` 末尾新增：

```powershell
Describe 'WebP 封存的清理與還原' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'
    }
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
    }

    It 'prune-bdd.ps1 以原檔雜湊確認 PNG 證據已收在 WebP 封存裡' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Register-AllExempt $t.bdd
        $r = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $r.archive -Status uploaded-verified -Attachment 1 -ArchiveRoot $archiveRoot | Out-Null
        $plan = & "$script:Scripts/prune-bdd.ps1" -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($plan.items | Where-Object topic -eq '1234-demo').action | Should -Be 'prune'
    }

    It '還原 WebP 封存後加入新一輪 PNG 證據，可以再封存' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        Convert-ToModuleLayout $t | Out-Null
        Register-AllExempt $t.bdd
        $first = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }

        $restoreRoot = Join-Path $base 'restore/.bdd'
        & "$script:Scripts/extract-bdd.ps1" -Archive $first.archive -To $restoreRoot | Out-Null
        $restored = Join-Path $restoreRoot '1234-demo'
        Test-Path -LiteralPath (Join-Path $restored 'features/m/01.feature') | Should -BeTrue
        New-TestPng (Join-Path $restored 'evidence/R3_DM-04_新畫面.png') '#123456'
        & "$script:Scripts/mask-evidence.ps1" -Dir $restored -Mark -Pattern 'R3_*' -Method exempt -Note '測試用純色圖' | Out-Null

        # 還原出來的資料夾不在 git 內：複製回 repo 的 .bdd 底下再封存，受測 commit 仍取 verification.json
        $again = Join-Path $t.repo '.bdd/1234-demo-r3'
        Copy-Item -LiteralPath $restored -Destination $again -Recurse
        $second = Invoke-Archive @{ Dir = $again; ArchiveRoot = $archiveRoot }
        $manifest = Read-Manifest $second.archive
        $names = @($manifest.files.PSObject.Properties.Name)
        $names | Should -Contain 'evidence/R3_DM-04_新畫面.webp'
        $names | Should -Contain 'evidence/R1_DM-01_首頁.webp'
        @($names | Where-Object { $_ -like 'features/*' }) | Should -Be @('features/m/01.feature')
    }
}
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddArchive.Tests.ps1 -Output Detailed"`
Expected: 第一個 It FAIL（action 為 `keep`，原因「有 N 個證據檔的內容不在已上傳的封存裡」）。第二個 It 若已通過，代表還原再封存的路徑本來就成立，保留作為回歸測試。

- [ ] **Step 3：修改 `prune-bdd.ps1` 的 `Get-ManifestHashes`**

把

```powershell
        @($manifest.files.PSObject.Properties | ForEach-Object { $_.Value.sha256 })
```

改成

```powershell
        # 轉成 WebP 的檔案同時認原檔雜湊：工作區留的是原始 PNG
        @($manifest.files.PSObject.Properties | ForEach-Object {
            $_.Value.sha256
            if ($_.Value.PSObject.Properties['originalSha256'] -and $_.Value.originalSha256) { $_.Value.originalSha256 }
        })
```

並在檔頭 `.DESCRIPTION` 第 2 點補一句：「封存內已轉成 WebP 的檔案，以 manifest 的 originalSha256 比對工作區的原圖。」

- [ ] **Step 4：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add skills/bdd-local-test/scripts/prune-bdd.ps1 skills/bdd-local-test/tests/BddArchive.Tests.ps1
git commit -m "#0000 fix(bdd-local-test): 清理證據時以原檔雜湊比對 WebP 封存" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8：重新壓縮既有封存（`recompress-bdd.ps1`）

**Files:**
- Create: `skills/bdd-local-test/scripts/recompress-bdd.ps1`
- Modify: `skills/bdd-local-test/scripts/lib/BddArchive.psm1`（`Get-ArchiveStates` 處理 `recompressed`；新增 `Find-ArchiveIndexRoot`）
- Modify: `skills/bdd-local-test/scripts/bdd-archive-index.ps1`（`Find-IndexRoot` 的往上找索引改呼叫 `Find-ArchiveIndexRoot`）
- Test: `skills/bdd-local-test/tests/BddArchive.Tests.ps1`（新增 Describe「recompress-bdd.ps1」）

**Interfaces:**
- Consumes: `New-PackEntry`、`Get-DedupPlan`、`Write-BddZip`、`Convert-PackEntriesToWebp`、`Update-PackMaskLedger`、`Update-PackMarkdownLinks`（Task 4、6）；`Get-WebpEncoder`（Task 3）。
- Produces:
  - `Find-ArchiveIndexRoot -ArchivePath <zip>` → 封存庫根目錄（從 zip 所在目錄往上最多 4 層找 `index.jsonl`），找不到丟例外。
  - `Get-ArchiveStates` 每筆新增 `recompressed`（bool）、`issueCopySha256`（第一次重新壓縮前的 SHA-256；issue 上的附件是這一版）。遇到 `recompressed` 事件時更新 `sha256`、`bytes`，狀態不變。
  - CLI：`recompress-bdd.ps1 -Archive <zip> [-ArchiveRoot <路徑>]` → JSON：`archive`、`changed`、`previousBytes`、`bytes`、`savedBytes`、`converted`、`skipped[]`、`sha256`。索引追加 `{ event = 'recompressed'; archive; previousSha256; previousBytes; sha256; bytes; encoder; converted; at }`。檔名與路徑不變。

- [ ] **Step 1：寫失敗的測試**

在 `BddArchive.Tests.ps1` 末尾新增：

```powershell
Describe 'recompress-bdd.ps1' {
    BeforeAll {
        $env:BDD_WEBP_ENCODER = $null
        Import-Module (Join-Path $script:Scripts 'lib/BddImage.psm1') -Force
        Import-Module (Join-Path $script:Scripts 'lib/BddArchive.psm1') -Force
        $script:HasPillow = (Get-WebpEncoder).kind -eq 'pillow'
    }
    BeforeEach {
        $env:BDD_ARCHIVE_ROOT = $null
        $base = Join-Path $TestDrive ([guid]::NewGuid().ToString('N').Substring(0, 8))
        $t = New-TestRepo $base
        $archiveRoot = Join-Path $base 'archives'
        # 先以「沒有編碼器」產生一份 PNG 版封存，模擬 1.3.0 留下的舊封存
        $env:BDD_WEBP_ENCODER = 'none'
        Register-AllExempt $t.bdd
        $old = Invoke-Archive @{ Dir = $t.bdd; ArchiveRoot = $archiveRoot }
        $env:BDD_WEBP_ENCODER = $null
    }

    It '重新壓縮後路徑不變、改成 WebP、索引記錄 recompressed 且狀態繼承' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $old.archive -Status uploaded-verified -Attachment 99 -ArchiveRoot $archiveRoot | Out-Null
        $r = & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | ConvertFrom-Json
        $r.changed | Should -BeTrue
        $r.archive | Should -Be $old.archive
        $r.converted | Should -Be 3
        $r.sha256 | Should -Be (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash
        (Read-Manifest $old.archive).files.PSObject.Properties.Name | Should -Contain 'evidence/R1_DM-01_首頁.webp'
        (Read-Manifest $old.archive).recompressedFrom.sha256 | Should -Be $old.sha256

        $state = Get-ArchiveStates $archiveRoot | Where-Object archive -eq $old.archive
        $state.status | Should -Be 'uploaded-verified'
        $state.recompressed | Should -BeTrue
        $state.issueCopySha256 | Should -Be $old.sha256
        $state.sha256 | Should -Be $r.sha256
        Test-Path -LiteralPath "$($old.archive).bak" | Should -BeFalse
    }

    It '重新壓縮後 prune-bdd.ps1 仍可據以清理' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/bdd-archive-index.ps1" -Mark -Archive $old.archive -Status uploaded-verified -Attachment 99 -ArchiveRoot $archiveRoot | Out-Null
        & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | Out-Null
        $plan = & "$script:Scripts/prune-bdd.ps1" -Repo $t.repo -ArchiveRoot $archiveRoot | ConvertFrom-Json
        ($plan.items | Where-Object topic -eq '1234-demo').action | Should -Be 'prune'
    }

    It '已是 WebP 的封存再跑一次時 changed = false，檔案不動' {
        if (-not $script:HasPillow) { Set-ItResult -Skipped -Because '沒有支援 WebP 的 Python Pillow'; return }
        & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | Out-Null
        $hash = (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash
        $again = & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive | ConvertFrom-Json
        $again.changed | Should -BeFalse
        (Get-FileHash -LiteralPath $old.archive -Algorithm SHA256).Hash | Should -Be $hash
    }

    It '封存檔與索引記錄的 SHA-256 不同時拒絕' {
        [IO.File]::AppendAllText($old.archive, 'x')
        { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*SHA-256*'
    }

    It '沒有編碼器時拒絕' {
        $env:BDD_WEBP_ENCODER = 'none'
        try { { & "$script:Scripts/recompress-bdd.ps1" -Archive $old.archive } | Should -Throw '*Pillow*' }
        finally { $env:BDD_WEBP_ENCODER = $null }
    }
}
```

- [ ] **Step 2：執行測試，確認失敗**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests/BddArchive.Tests.ps1 -Output Detailed"`
Expected: 「recompress-bdd.ps1」的 It FAIL（腳本不存在）。

- [ ] **Step 3：`BddArchive.psm1` 處理 `recompressed` 事件並新增 `Find-ArchiveIndexRoot`**

1. `Get-ArchiveStates` 的 `created` 分支內，`legacy = ...` 之後加入：

```powershell
                recompressed = $false
                issueCopySha256 = $null
```

2. 在 `elseif ($e.event -eq 'status' ...)` 區塊之後加入：

```powershell
        } elseif ($e.event -eq 'recompressed' -and $states.Contains($key)) {
            # 重新壓縮：檔案內容換成 WebP 版，狀態不變；issue 上的附件仍是第一次重新壓縮前的版本
            if (-not $states[$key].issueCopySha256) { $states[$key].issueCopySha256 = $e.previousSha256 }
            $states[$key].sha256 = $e.sha256
            $states[$key].bytes = $e.bytes
            $states[$key].recompressed = $true
```

並更新該函式的說明：「每筆含 ...、legacy、recompressed（是否重新壓縮過）、issueCopySha256（issue 附件那一版的 SHA-256，未重新壓縮為 null）。」

3. 在 `Get-ArchiveStates` 之前加入：

```powershell
<#
.SYNOPSIS
  從封存檔所在目錄往上最多 4 層尋找 index.jsonl，回傳封存庫根目錄；找不到丟例外。
#>
function Find-ArchiveIndexRoot([Parameter(Mandatory)][string]$ArchivePath) {
    $dir = Split-Path (Get-NormalizedPath $ArchivePath) -Parent
    for ($i = 0; $i -lt 4 -and $dir; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir 'index.jsonl')) { return $dir }
        $dir = Split-Path $dir -Parent
    }
    throw "找不到封存索引 index.jsonl（從 $ArchivePath 往上 4 層），請以 -ArchiveRoot 指定"
}
```

4. `bdd-archive-index.ps1` 的 `Find-IndexRoot` 內，把

```powershell
    if ($Archive -and -not $Import) {
        $dir = Split-Path (Get-NormalizedPath $Archive) -Parent
        for ($i = 0; $i -lt 4 -and $dir; $i++) {
            if (Test-Path -LiteralPath (Join-Path $dir 'index.jsonl')) { return $dir }
            $dir = Split-Path $dir -Parent
        }
    }
```

改成

```powershell
    if ($Archive -and -not $Import) {
        try { return Find-ArchiveIndexRoot $Archive } catch { if (-not $Repo) { throw } }
    }
```

- [ ] **Step 4：實作 `recompress-bdd.ps1`**

建立 `skills/bdd-local-test/scripts/recompress-bdd.ps1`：

```powershell
<#
.SYNOPSIS
  把既有的 BDD 封存（PNG 截圖）重新壓縮成無損 WebP 版，路徑與檔名不變，並在封存索引記錄 recompressed。

.DESCRIPTION
  流程：核對封存檔與索引的 SHA-256 → 解到暫存目錄並依 manifest 還原 aliases → 截圖轉無損 WebP（逐像素驗證）
  → 改寫封存內的遮罩紀錄與報告連結 → 去重、打包、逐檔驗證 → 以新檔取代舊檔 → 索引追加 recompressed。
  索引狀態（例如 uploaded-verified）不變；issue 上的附件仍是原本的 PNG 版，索引以 issueCopySha256 記錄那一版。
  沒有可轉的截圖時不改動檔案（changed = false）。需要支援 WebP 的 Python Pillow。
  舊版沒有 manifest 的封存也可處理，結果會補上 manifest（legacy = true）。

.PARAMETER Archive
  要重新壓縮的封存檔。

.PARAMETER ArchiveRoot
  封存庫根目錄；省略時從封存檔往上找 index.jsonl。

.EXAMPLE
  pwsh -NoProfile -File recompress-bdd.ps1 -Archive ~/bdd-archives/bsaila/5349/5349-schedule-settings-list-ui-dfdbcad-20261001T180553.zip
#>
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [string]$ArchiveRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddArchive.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/BddImage.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/BddPack.psm1') -Force
Add-Type -AssemblyName System.IO.Compression

$archivePath = Get-NormalizedPath $Archive
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "封存檔不存在：$archivePath" }
$root = if ($ArchiveRoot) { Get-NormalizedPath $ArchiveRoot } else { Find-ArchiveIndexRoot $archivePath }
$state = Get-ArchiveStates $root | Where-Object { (Get-NormalizedPath $_.archive) -ieq $archivePath } | Select-Object -First 1
if (-not $state) { throw "索引裡沒有這個封存檔：$archivePath（索引：$root）" }
$actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actual -ne $state.sha256) { throw "封存檔 SHA-256 與索引記錄不同（記錄 $($state.sha256)、目前 $actual），拒絕重新壓縮" }
$encoder = Get-WebpEncoder
if (-not $encoder.kind) { throw '沒有可用的 WebP 編碼器（需要支援 WebP 的 Python Pillow），無法重新壓縮' }

$staging = Join-Path ([IO.Path]::GetTempPath()) ('bdd-recompress-' + [IO.Path]::GetRandomFileName())
$sourceDir = Join-Path $staging 'src'
[IO.Directory]::CreateDirectory($sourceDir) | Out-Null
$newZip = "$archivePath.recompress.zip"
$backup = "$archivePath.bak"
if (Test-Path -LiteralPath $newZip) { throw "上次重新壓縮留下的暫存檔仍在，請確認後刪除：$newZip" }
if (Test-Path -LiteralPath $backup) { throw "上次重新壓縮留下的備份仍在，請確認後處理：$backup" }

try {
    # 1. 解到暫存目錄（去掉第一層資料夾），並依 manifest 還原 aliases
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($zip.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
        $manifestEntry = $entries | Where-Object { $_.FullName -match '^[^/]+/bdd-manifest\.json$' } | Select-Object -First 1
        $manifest = $null
        if ($manifestEntry) {
            $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
            try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        }
        $firstSegments = @($entries | ForEach-Object { ($_.FullName -split '/', 2)[0] } | Sort-Object -Unique)
        $hasFolder = $firstSegments.Count -eq 1 -and @($entries | Where-Object { $_.FullName -notlike '*/*' }).Count -eq 0
        $prefix = if ($hasFolder) { "$($firstSegments[0])/" } else { '' }
        foreach ($entry in $entries) {
            if ($manifestEntry -and $entry.FullName -eq $manifestEntry.FullName) { continue }
            $relative = $entry.FullName.Substring($prefix.Length)
            if ($relative -match '(^|/)\.\.(/|$)' -or $relative -match '^[A-Za-z]:' -or $relative.StartsWith('/')) { throw "封存含不安全的路徑：$($entry.FullName)" }
            $target = Get-NormalizedPath (Join-Path $sourceDir $relative)
            if (-not (Test-PathUnder $target $sourceDir)) { throw "封存項目解壓後會跑出暫存目錄：$($entry.FullName)" }
            [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        }
    } finally { $zip.Dispose() }
    if ($manifest) {
        foreach ($p in $manifest.aliases.PSObject.Properties) {
            $aliasPath = Get-NormalizedPath (Join-Path $sourceDir $p.Name)
            if (-not (Test-PathUnder $aliasPath $sourceDir)) { throw "manifest 的 alias 路徑不安全：$($p.Name)" }
            [IO.Directory]::CreateDirectory((Split-Path $aliasPath -Parent)) | Out-Null
            Copy-Item -LiteralPath (Join-Path $sourceDir $p.Value) -Destination $aliasPath
        }
    }

    # 2. 建立封存項目，保留舊 manifest 每個檔案的附加欄位（例如 scenarioPath、originalName）
    $packEntries = @(Get-ChildItem -LiteralPath $sourceDir -Recurse -File | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($sourceDir, $_.FullName).Replace('\', '/')
        $extra = [ordered]@{}
        if ($manifest -and $manifest.files.PSObject.Properties[$relative]) {
            foreach ($prop in $manifest.files.$relative.PSObject.Properties) {
                if ($prop.Name -notin 'sha256', 'size') { $extra[$prop.Name] = $prop.Value }
            }
        }
        New-PackEntry -Relative $relative -Path $_.FullName -Extra $extra
    })

    # 3. 轉檔；沒有任何截圖轉成功就不改動
    $webp = Convert-PackEntriesToWebp -Entries $packEntries -Encoder $encoder -Staging $staging
    if (-not @($webp.converted).Count) {
        [pscustomobject]@{ archive = $archivePath; changed = $false; previousBytes = $state.bytes; bytes = $state.bytes; savedBytes = 0
            converted = 0; skipped = @($webp.skipped); sha256 = $actual } | ConvertTo-Json -Depth 4
        return
    }
    $packEntries = Update-PackMaskLedger -Entries $webp.entries -Converted $webp.converted -Staging $staging
    $links = Update-PackMarkdownLinks -Entries $packEntries -Converted $webp.converted -Staging $staging
    $plan = Get-DedupPlan $links.entries
    $saved = [long](($webp.converted | ForEach-Object { $_.sourceBytes - $_.webpBytes } | Measure-Object -Sum).Sum)

    # 4. 新 manifest：沿用舊欄位，覆寫檔案清單與轉檔資訊；舊版封存補上基本欄位
    $newManifest = [ordered]@{}
    if ($manifest) { foreach ($prop in $manifest.PSObject.Properties) { $newManifest[$prop.Name] = $prop.Value } }
    else {
        $newManifest.tool = 'bdd-local-test/recompress-bdd.ps1'
        $newManifest.legacy = $true
        $newManifest.issue = $state.issue
        $newManifest.topic = $state.topic
        $newManifest.commit = $state.commit
        $newManifest.masked = $false
        $newManifest.unmaskedReason = '舊版封存，未經遮罩登記檢查'
    }
    $newManifest.schema = 2
    $newManifest.storedFileCount = $plan.stored.Count
    $newManifest.files = $plan.files
    $newManifest.aliases = $plan.aliases
    $newManifest.webp = [ordered]@{ encoder = $encoder.kind; converted = @($webp.converted).Count; skipped = @($webp.skipped); savedBytes = $saved }
    $newManifest.rewrittenLinks = $links.rewritten
    $newManifest.recompressedFrom = [ordered]@{ sha256 = $actual; bytes = $state.bytes; at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }
    $outPrefix = if ($prefix) { $prefix } else { "$($state.topic)/" }

    # 5. 寫新檔、驗證，再取代舊檔（取代失敗就還原）
    Write-BddZip -Stored $plan.stored -Prefix $outPrefix -ManifestJson ($newManifest | ConvertTo-Json -Depth 8) -Target $newZip
    Move-Item -LiteralPath $archivePath -Destination $backup
    try { Move-Item -LiteralPath $newZip -Destination $archivePath }
    catch { Move-Item -LiteralPath $backup -Destination $archivePath; throw }
    Remove-Item -LiteralPath $backup -Force

    $sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    $bytes = (Get-Item -LiteralPath $archivePath).Length
    Add-ArchiveIndexEvent $root ([ordered]@{
        event = 'recompressed'; archive = $state.archive; previousSha256 = $actual; previousBytes = $state.bytes
        sha256 = $sha256; bytes = $bytes; encoder = $encoder.kind; converted = @($webp.converted).Count
        at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
    })
    [pscustomobject]@{
        archive = $archivePath; changed = $true; previousBytes = $state.bytes; bytes = $bytes; savedBytes = [long]$state.bytes - $bytes
        converted = @($webp.converted).Count; skipped = @($webp.skipped); sha256 = $sha256
    } | ConvertTo-Json -Depth 4
} finally {
    if (Test-Path -LiteralPath $newZip) { Remove-Item -LiteralPath $newZip -Force }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
```

- [ ] **Step 5：執行測試，確認通過**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: PASS。

- [ ] **Step 6：Commit**

```bash
git add skills/bdd-local-test/scripts/recompress-bdd.ps1 skills/bdd-local-test/scripts/lib/BddArchive.psm1 skills/bdd-local-test/scripts/bdd-archive-index.ps1 skills/bdd-local-test/tests/BddArchive.Tests.ps1
git commit -m "#0000 feat(bdd-local-test): 新增既有封存重新壓縮為無損 WebP 的腳本" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9：SKILL.md 與參考文件改成模組情境流程，版本升到 1.4.0

**Files:**
- Create: `skills/bdd-local-test/references/modules.md`
- Modify: `skills/bdd-local-test/SKILL.md`
- Modify: `skills/bdd-local-test/references/feature-guide.md`
- Modify: `skills/bdd-local-test/references/archive.md`
- Modify: `skills/bdd-local-test/references/scenario-review.md`
- Modify: `skills/bdd-local-test/assets/REPORT-template.md`
- Modify: `skills/bdd-local-test/evals/evals.json`
- Modify: `README.md`、`plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: Task 1–8 的腳本與參數名稱（`bdd-modules.ps1 -Lint／-NextId -Module／-Base`、`bdd-verification.ps1 -ChangedScenarios／-RegressionScenarios`、`recompress-bdd.ps1 -Archive`、`.bdd/config.json` 的 `webp`）。
- Produces: 文件；無程式介面。

- [ ] **Step 1：建立 `references/modules.md`**

```markdown
# 模組情境集

情境照**功能模組**持續維護，證據照 **issue** 封存。這份說明模組怎麼切、MODULE.md 怎麼寫、編號與撞號怎麼處理。

## 為什麼分兩層

| | 證據（截圖、REPORT.md、verification.json） | 情境（.feature） |
|---|---|---|
| 性質 | 某個 commit 當下的驗證快照，結案後不再改 | 功能「現在應該怎樣」，隨需求演進 |
| 放哪裡 | `.bdd/<單號>-<主題>/` | `.bdd/modules/<portal>/<主路由>/` |

同一個模組被多張單修改時，後一張單**修改模組裡的情境**，不另寫一份。issue 層只留本輪的結果與證據，`verification.json` 記錄跑了哪些模組情境。

## 模組怎麼切

- 預設 **portal＋主路由**，例如 `organizer/schedule-settings`、`organizer/matches`、`member/ad-cooperation`；排程程式用 `job/<程式名>`。
- 共用元件、全站樣式的外溢情境放 **shared 模組**：`<portal>/shared/<元件名>`，例如 `organizer/shared/category-tabs`。
- 一個模組一個目錄，目錄內一份 `MODULE.md` 與若干 `NN-<英文主題>.feature`。不要在模組目錄底下再開子模組。

## MODULE.md

```markdown
---
prefix: SS
paths:
  - Project/frontend/organizer-portal/src/app/pages/schedule-settings/**
  - Project/backend/EventPlatform.BLL/Services/ScheduleSettingService.cs
issues:
  - 5349
  - 5354
removed:
  - SS-07 #5400 需求取消，改由賽程結果頁處理
---

# organizer/schedule-settings 賽制管理

- 入口：organizer-portal 賽程管理 > 賽制管理（/race/:raceId/schedule-settings/:divisionId）
- 範圍：賽制列表、組別賽制編輯、儲存列
```

| 欄位 | 說明 |
|------|------|
| `prefix` | 2–3 個大寫英文字母，整個 repo 內唯一 |
| `paths` | 對應程式路徑（glob，`**` 跨目錄）；`bdd-modules.ps1 -Base` 依此從異動檔案找出模組 |
| `issues` | 新增或修改過本模組情境的單號 |
| `removed` | 已刪除的編號：`<編號> #<單號> <原因>`；這些編號不可再用 |

front matter 之後的正文寫給人看：入口、範圍、注意事項。

## 編號

- 模組內流水號，新增的用 `bdd-modules.ps1 -NextId -Module <模組>` 取得（現有與已移除的最大號加一）。
- 用過的號碼不重用；刪除情境時在 `removed` 記一行。
- 修改既有情境的預期：改在原地，補上本單的單號標籤，例如 `@SS-03 @#5349 @#5410 @UI`。
- 每個情境要有：一個編號、至少一個單號標籤、至少一個 `@UI`／`@API`／`@DB`。

## 檢查

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-modules.ps1" -Lint
```

有問題時 exit 1 並列出：編號重複、前綴重複、編號前綴不符、缺單號或驗證手段標籤、用回已移除的編號、情境檔所在目錄沒有 MODULE.md、MODULE.md 格式錯誤。在〈3-1〉送審前與〈7-1〉合併後各跑一次，**有問題不進入執行、不推 develop**。

## 並行分支撞號

兩條分支都從 develop 開出、都新增了 `SS-13`：

1. 〈7-1〉把功能分支合併進最新的 `origin/develop` 時處理。
2. **只有 `.bdd/modules/` 底下有衝突**時自行解：`.feature` 兩邊的情境都保留，本分支新增的情境改用 `-NextId` 取得的新號；`MODULE.md` 的 `issues`、`removed` 取聯集。只要有 `.bdd/modules/` 以外的檔案衝突，就照現行規則停下來回報，`.bdd/modules/` 的衝突也不先解。
3. 沒有文字衝突、但 `-Lint` 報 `duplicate-id` 時，同樣把本分支新增的改號。
4. 改號寫進 REPORT〈情境修訂〉（例如「`SS-13`→`SS-15`（與 #5401 撞號）」）；合併後重跑那一輪的證據用新編號，舊輪次證據保留原檔名。

## 遷移舊資料（使用者要求時）

舊版每張單的 `.feature` 放在 issue 資料夾裡。整併到模組的步驟：

1. 列出對照表給使用者確認：每個舊情境 → 模組、新編號、合併／保留／刪除與理由。內容重複或矛盾要語意判斷，不靠腳本。
2. 確認後寫進 `.bdd/modules/`，整批依〈3-1〉送子代理審核，並通過 `-Lint`。
3. 刪除 issue 資料夾裡的 `.feature`（git 歷史與封存都還在），舊 REPORT.md 與 verification.json 不動。
4. 新增 `.bdd/modules/MIGRATION-<年>-<月>.md`，記錄舊編號 → 新編號。

進行中的單（功能分支還沒併回）不要遷移。
```

- [ ] **Step 2：修改 `SKILL.md`**

1. 開頭第 15–16 行「所以產出是四樣東西放在同一個資料夾：…」改為：

```markdown
所以產出分兩處：**模組情境**放 `.bdd/modules/<portal>/<主路由>/`，跨單子持續維護；**本輪結果**放 `.bdd/<單號>-<主題>/`：
`evidence/` 證據、`REPORT.md` 結果，以及記錄「這份結果是在哪個 repo、哪個 commit、跑了哪些情境」的 `verification.json`。
```

2. 〈1. 確認範圍與輸出位置〉的「輸出資料夾」一項後面加入：

```markdown
- **模組情境**：`<git 根目錄>/.bdd/modules/<portal>/<主路由>/`。切法、MODULE.md 格式、編號規則見 [模組情境集](references/modules.md)。
  repo 還沒有 `.bdd/modules/` 但 issue 資料夾裡有舊的 `.feature` 時，照舊格式接著做，並提醒使用者可以依 modules.md〈遷移舊資料〉整併；不要自己遷移。
```

3. 〈2. 蒐集事實〉的程式碼區塊之後加入：

```markdown
- **找出受影響的模組**：
  ```bash
  pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-modules.ps1" -Base <基準>
  ```
  `modules` 是命中的模組，先讀它們現有的情境——那是這個功能目前的規則，本單要在上面修改。
  `unmatched` 裡有屬於前端頁面或後端服務的檔案時，依「portal＋主路由」提出新模組（名稱、前綴、paths），**請使用者確認後**才建立 MODULE.md；
  被當成子代理執行、無法確認時，情境暫時寫在 issue 資料夾，報告標註「模組待定」。
```

4. 〈3. 寫情境〉第一個重點「依功能區塊拆檔…」改為：

```markdown
- 情境寫在**模組**裡：修改或新增既有模組的 `.feature`，不在 issue 資料夾另寫一份。新情境的編號用 `bdd-modules.ps1 -NextId -Module <模組>` 取得，
  每個情境標上本單單號（`@#5349`）；修改既有情境時在原地改，補上本單單號。
- 本單沒改、但屬於受影響模組的情境，挑和異動相關的列為**回歸**，一起執行。
```

並在〈3. 寫情境〉清單最後加入：

```markdown
- 寫完先跑 `bdd-modules.ps1 -Lint`，通過才送審。
```

5. 〈3-1. 子代理獨立審核情境〉第一個重點之後加入：

```markdown
- 審核範圍：本單新增或修改的模組情境，以及同一 `功能` 內的其他情境（看有沒有重複或互相矛盾）。
```

6. 〈6. 逐情境執行〉的「若發現是**情境本身寫錯**」一項，「根據需求修正情境」改為「根據需求修正**模組裡的**情境」。

7. 〈7. 產出 REPORT.md 並清理〉的 `-Record` 指令改為：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-verification.ps1" -Record -Dir <輸出資料夾>   -Base <基準分支> -Passed N -Failed N -Blocked N -NotRun N   -ChangedScenarios <本單新增或修改的 .feature，逗號分隔>   -RegressionScenarios "<回歸的 .feature>::<編號>,<編號>"   -Note "<一句話>"
```

並在指令之後加入：

```markdown
`-ChangedScenarios`／`-RegressionScenarios` 每項是「`<repo 相對路徑>`」（取檔內全部情境）或「`<路徑>::<編號>,<編號>`」。
情境檔要先 commit：封存時會從受測 commit 取出當時那一版放進 ZIP，受測時未提交的情境會讓封存失敗。
```

8. 〈7-1〉第 2 點「遇衝突就保留原分支與整合工作區供檢查…」之前加入：

```markdown
   **衝突只發生在 `.bdd/modules/` 底下時自行解**，做法見 [模組情境集](references/modules.md)〈並行分支撞號〉；合併後一律跑 `bdd-modules.ps1 -Lint`，有問題先改號再重跑。
```

9. 〈7-3〉第 1 點的腳本說明，「腳本會攤平舊 `evidence.zip`、檢查每張圖片都有遮罩登記、依內容去重…」改為：

```markdown
腳本會攤平舊 `evidence.zip`、檢查每張圖片都有遮罩登記、**放入受測 commit 當時的模組情境（`features/`）、截圖轉成無損 WebP（有支援 WebP 的 Python Pillow 時；沒有就保留原格式並在 `warnings` 提醒）**、依內容去重、寫入 `bdd-manifest.json`、逐檔比對 SHA-256，並在封存庫的 `index.jsonl` 登記…
```

（句子其餘部分不變。）

- [ ] **Step 3：修改 `references/feature-guide.md`**

1. 〈檔頭〉的範例改為：

```gherkin
# language: zh-TW
# 範圍：<portal> <功能區塊>（模組 <portal>/<主路由>）
# 入口：<哪個前端> <選單路徑>（<路由>）
# 標籤：@UI 瀏覽器操作｜@API 直接呼叫端點｜@DB 查資料庫驗證｜@已知缺陷 撰寫時已知會失敗｜@#<單號> 新增或修改此情境的單
# 情境編號 <前綴>-xx 供測試報告對照，前綴見 MODULE.md
```

並在範例後加一句：「檔頭描述的是模組，不是某一張單的分支差異；單號寫在各情境的 `@#<單號>` 標籤。」

2. 〈結構〉範例的 `@<編號> @UI @DB` 改為 `@<編號> @#<單號> @UI @DB`。

3. 〈編號〉整節改為：

```markdown
## 編號

- 每個模組一個 2–3 字母前綴，登記在該模組的 `MODULE.md`（`SS` 賽制管理、`MT` 場地時間表），情境依序 `SS-01`、`SS-02`…
- 新增情境用 `bdd-modules.ps1 -NextId -Module <模組>` 取號；用過的號碼不重用，刪除的記進 MODULE.md 的 `removed`。
- 編號一旦寫進報告與證據檔名就不要重排。並行分支撞號時的改號規則見 [模組情境集](modules.md)。
```

- [ ] **Step 4：修改 `references/archive.md`**

1. 〈三層儲存〉表格的工作區一列改為：「`<worktree>/.bdd/<單號-主題>/` ｜ `REPORT.md`、`verification.json`、`masking.json`、`evidence/`（模組情境在 `.bdd/modules/`，不在這裡） ｜ 證據在封存並確認上傳後由 `prune-bdd.ps1` 清掉；報告保留」。

2. 〈專案設定 `.bdd/config.json`〉的 JSON 範例加入 `"webp": "auto",`，表格加一列：

```markdown
| `webp` | `auto`：有支援 WebP 的 Python Pillow 就把截圖轉成無損 WebP；`off`：不轉 | `auto` |
```

3. 〈封存〉的腳本步驟改為：

```markdown
1. 檢查 `REPORT.md`、`verification.json` 與證據都在、沒有符號連結；情境來自輸出資料夾的 `.feature`（舊格式）或 `verification.json` 最後一輪的 `scenarios`，兩者都沒有就停止。
2. **攤平**：舊輪次的 `evidence.zip` 解回 `evidence/`；同名同內容略過，同名不同內容就停止。`evidence.zip` 本身不收入封存。
3. **遮罩檢查**：每張圖片都要有有效的遮罩登記，否則列出缺漏的檔案並停止。
4. **情境快照**：依 `scenarios` 從受測 commit 取出當時的 `.feature`，放在 ZIP 的 `features/<模組路徑>/`。紀錄的 blob 與受測 commit 不符，或受測時情境未提交，就停止。
5. **轉無損 WebP**：`evidence/` 底下的 PNG／JPG／BMP 轉成無損 WebP，解碼回來逐像素比對一致、而且檔案變小才採用，否則保留原檔並記在 manifest 的 `webp.skipped`。ZIP 內的 `masking.json` 改以 `.webp` 登記（保留 `derivedFrom`），`.md` 檔裡的截圖連結改成 `.webp`；工作區的原檔都不動。沒有 Pillow 時保留原格式，`warnings` 出現 `webpUnavailable`。
6. **去重**：內容相同的檔案只存一份，其餘記在 `bdd-manifest.json` 的 `aliases`。
7. 打包成暫存檔，逐檔核對 SHA-256 後才搬到封存庫；任何失敗都不留半成品。
8. 在 `index.jsonl` 追加 `created`，並把同 repo 同主題、尚未被取代的舊封存標為 `superseded`。
```

4. 〈封存〉之後新增一節：

```markdown
## 重新壓縮既有封存

1.3.0 以前的封存（或封存時沒有 Pillow）截圖仍是 PNG，可以事後轉成無損 WebP：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/recompress-bdd.ps1" -Archive <zip>
```

路徑與檔名不變，索引追加 `recompressed` 事件，狀態（例如 `uploaded-verified`）不變。issue 上的附件仍是原本的 PNG 版，那是正式紀錄，不重新上傳；索引以 `issueCopySha256` 記錄那一版的 SHA-256。`prune-bdd.ps1` 以 manifest 的 `originalSha256` 比對工作區原圖，所以重新壓縮後仍可據以清理。
```

5. 〈索引與狀態〉表格之後加一句：「`recompressed` 事件只換檔案內容，不改狀態。」

- [ ] **Step 5：修改 `references/scenario-review.md`**

1. 〈什麼時候要審〉表格第二列改為：「既有模組補新情境、修改『那麼』、整併舊情境 ｜ 新增與被改動的情境，加上同一 `功能` 內的其他情境（看有沒有重複或互相矛盾）」。

2. 〈子代理指示範本〉的「待審情境」一行改為：

```text
待審情境：<模組 .feature 路徑清單>（本次範圍：<編號清單>；同檔其他情境請一併檢查是否重複或矛盾）
模組說明：<各模組 MODULE.md 路徑>
```

3. 範本第 6 點改為：「6. 格式：檔頭、編號唯一且未重排、每個情境有單號標籤（@#單號）與驗證手段標籤、BDD- 前綴、一個情境只驗一件事、沒有寫入帳密或連線字串。」

- [ ] **Step 6：修改 `assets/REPORT-template.md`**

在〈情境審核〉之前新增：

```markdown
## 本輪執行情境

| 模組 | 情境檔 | 編號 | 角色 |
|------|--------|------|------|
| `<portal>/<主路由>` | `.bdd/modules/<…>/NN-<主題>.feature` | `<前綴>-xx`、`<前綴>-yy` | 本單新增／修改 |
| `<portal>/<主路由>` | `.bdd/modules/<…>/NN-<主題>.feature` | `<前綴>-zz` | 回歸 |

<與 verification.json 的 scenarios 一致。舊格式（情境在本資料夾內）寫「本資料夾 .feature」。>
```

標題表格的「證據封存」列，說明改為：「<全部通過時：待依〈7-3〉封存到本機封存庫並上傳 issue（截圖轉無損 WebP、附受測當時的模組情境），實際檔案、SHA-256 與索引狀態見 issue 後續註記或最終回覆；否則：未封存，證據在 `evidence/`>」。

- [ ] **Step 7：修改 `evals/evals.json`**

在 `evals` 陣列末尾加入（`id` 取現有最大值加一）：

```json
{
  "id": 10,
  "prompt": "#5410 又改了賽制管理列表（organizer/schedule-settings 已有模組情境 SS-01～SS-12），幫我寫情境、本機測到全部通過並收尾。",
  "expected_output": "在 .bdd/modules/organizer/schedule-settings/ 修改或新增情境（新編號接 SS-13 起、標 @#5410），沒有在 .bdd/5410-*/ 另寫 .feature；bdd-modules.ps1 -Lint 通過後送子代理審核；verification.json 的 scenarios 區分 changed 與 regression；封存 ZIP 內有 features/ 快照且截圖為 WebP。",
  "files": [],
  "assertions": [
    "情境寫在 .bdd/modules/organizer/schedule-settings/，issue 資料夾沒有 .feature",
    "新情境編號從 SS-13 起且未重用 MODULE.md removed 的編號",
    "新增或修改的情境帶 @#5410 標籤",
    "送審前執行 bdd-modules.ps1 -Lint 且結果為通過",
    "verification.json 最後一輪有 scenarios，含 changed 與 regression",
    "REPORT〈本輪執行情境〉與 scenarios 一致",
    "封存 manifest 的 features 列出模組情境檔，截圖項目為 .webp 或 webp.skipped 說明原因"
  ]
}
```

- [ ] **Step 8：README 與版本**

1. `README.md` 第 12 行「情境寫完會先交給子代理獨立審核…」之前加入：「情境照功能模組持續維護在 `.bdd/modules/`，每張單只留本輪結果與證據（見 `skills/bdd-local-test/references/modules.md`）；封存時截圖轉成無損 WebP，約省一半空間。」
2. `plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 的 `"version": "1.3.0"` 改為 `"version": "1.4.0"`。

- [ ] **Step 9：檢查文件裡的腳本與參數名稱都存在**

Run:

```bash
cd skills/bdd-local-test && grep -ohE '(bdd-modules|bdd-verification|recompress-bdd|archive-bdd|prune-bdd|extract-bdd|mask-evidence|bdd-archive-index)\.ps1' SKILL.md references/*.md | sort -u | while read f; do test -f "scripts/$f" && echo "ok $f" || echo "MISSING $f"; done
grep -ohE -- '-(ChangedScenarios|RegressionScenarios|NextId|Lint|Base|Archive)\b' SKILL.md references/*.md | sort -u
```

Expected: 每個腳本都是 `ok`；參數清單只有上面六個名稱（與 Task 1、2、8 的定義一致）。

- [ ] **Step 10：Commit**

```bash
git add README.md plugin.json .claude-plugin/plugin.json .codex-plugin/plugin.json skills/bdd-local-test/SKILL.md skills/bdd-local-test/references skills/bdd-local-test/assets/REPORT-template.md skills/bdd-local-test/evals/evals.json
git commit -m "#0000 feat(bdd-local-test): 流程改為情境照模組維護、證據照 issue 封存並升版 1.4.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10：整體驗證

**Files:**
- 不改程式；只在 scratchpad 產生暫存資料。

**Interfaces:**
- Consumes: Task 1–9 全部。
- Produces: 驗證紀錄（貼在交接回覆裡）。

- [ ] **Step 1：全部 Pester 測試**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests -Output Detailed"`
Expected: 全部通過；Pillow 相關的 It 是 Passed，不是 Skipped。

- [ ] **Step 2：用真實封存的複本驗證節省幅度與逐像素一致**

不動真實封存庫，在 scratchpad 複製一份 bsaila 封存庫（含 `index.jsonl`）：

```bash
S="<scratchpad>/recompress-check"; rm -rf "$S"; mkdir -p "$S"; cp -r ~/bdd-archives/bsaila "$S/"
W=$(cygpath -w "$S/bsaila")
# 索引裡是原始路徑，複本要改寫成複本路徑才能對上（兩邊都先 normpath，避免斜線混用）
python - "$W" <<'EOF'
import json, sys, os
root = os.path.normpath(sys.argv[1]); src = os.path.normpath(os.path.expanduser('~/bdd-archives/bsaila'))
p = os.path.join(root, 'index.jsonl')
lines = [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
for e in lines:
    for k in ('archive', 'by'):
        if e.get(k):
            e[k] = os.path.normpath(e[k]).replace(src, root)
open(p, 'w', encoding='utf-8').write(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in lines))
EOF
find "$S/bsaila" -name '*.zip' | while read z; do
  pwsh -NoProfile -File skills/bdd-local-test/scripts/recompress-bdd.ps1 -Archive "$(cygpath -w "$z")" -ArchiveRoot "$W" |
    python -c "import json,sys; d=json.load(sys.stdin); print(d['changed'], d['previousBytes'], d['bytes'], d['converted'])"
done
du -sh ~/bdd-archives/bsaila "$S/bsaila"
```

Expected: 每個非 superseded 的封存 `changed = True`；總量由約 23 MB 降到約 11 MB。（`superseded` 的封存也會處理，數字照實記錄。）

- [ ] **Step 3：逐像素抽查**

```bash
python - "$(cygpath -w '<scratchpad>/recompress-check/bsaila')" <<'EOF'
import zipfile, glob, io, sys, json, os
from PIL import Image
root = os.path.normpath(sys.argv[1]); src = os.path.normpath(os.path.expanduser('~/bdd-archives/bsaila')); checked = 0
for z in glob.glob(os.path.join(root, '**', '*.zip'), recursive=True):
    orig = os.path.normpath(z).replace(root, src)
    with zipfile.ZipFile(z) as new, zipfile.ZipFile(orig) as old:
        manifest = json.loads(new.read([n for n in new.namelist() if n.endswith('bdd-manifest.json')][0]))
        prefix = [n for n in new.namelist() if n.endswith('bdd-manifest.json')][0].rsplit('/', 1)[0] + '/'
        oldnames = set(old.namelist())
        for name, rec in manifest['files'].items():
            if not rec.get('originalName') or name in manifest.get('aliases', {}):
                continue
            src = next((n for n in oldnames if n.endswith('/' + rec['originalName']) or n == rec['originalName']), None)
            if not src:
                continue
            a = Image.open(io.BytesIO(old.read(src))).convert('RGBA'); b = Image.open(io.BytesIO(new.read(prefix + name))).convert('RGBA')
            assert a.size == b.size and a.tobytes() == b.tobytes(), name
            checked += 1
print('pixel-identical', checked)
EOF
```

Expected: 印出 `pixel-identical N`，N 約 200，沒有 AssertionError。

- [ ] **Step 4：端對端演練（模組情境 → 記錄 → 封存）**

在 scratchpad 建一個小 repo：一個模組（MODULE.md＋01.feature，commit）、`.bdd/9999-demo/`（REPORT.md、evidence 一張 PNG）。依序執行：

```bash
pwsh -NoProfile -File skills/bdd-local-test/scripts/bdd-modules.ps1 -Repo <repo> -Lint          # exit 0
cd <repo> && pwsh -NoProfile -File <skill>/scripts/bdd-verification.ps1 -Record -Dir .bdd/9999-demo -Commits HEAD -Passed 1 -ChangedScenarios .bdd/modules/<模組>/01.feature
pwsh -NoProfile -File <skill>/scripts/mask-evidence.ps1 -Dir .bdd/9999-demo -Mark -Method exempt -Note '演練用'
pwsh -NoProfile -File <skill>/scripts/archive-bdd.ps1 -Dir .bdd/9999-demo -ArchiveRoot <scratchpad>/e2e-archives
```

Expected: 封存輸出 `webpConverted = 1`；ZIP 內有 `9999-demo/features/<模組>/01.feature`、`9999-demo/evidence/*.webp`、`bdd-manifest.json` 的 `schema = 2`。

- [ ] **Step 5：回報**

把 Step 1–4 的數字（測試數、封存前後大小、逐像素抽查數、演練輸出）整理給使用者。**不推送、不合併 main、不更新已安裝的 plugin**：這些由使用者決定。

---

## 交付物 2：bsaila 整併（1.4.0 合併、安裝之後另行執行）

這部分是資料整理，不是程式開發；每一步都要使用者確認，不在本計畫的自動執行範圍內。執行時依 `references/modules.md`〈遷移舊資料〉：

1. 在 bsaila 依偏好開功能分支（單號屆時向使用者確認），讀 `.bdd/*/` 的 30 個 `.feature`，整理對照表（舊編號 → 模組、新編號、合併／保留／刪除與理由），`sport-format-analysis` 的歸屬請使用者決定。
2. 使用者確認後建立 `.bdd/modules/<portal>/<主路由>/MODULE.md` 與 `.feature`，整批派子代理審核（scenario-review.md），`bdd-modules.ps1 -Lint` 通過。
3. 刪除各 issue 資料夾裡的 `.feature`，新增 `.bdd/modules/MIGRATION-2026-10.md`。
4. 對 `~/bdd-archives/bsaila/` 的 8 個封存逐一執行 `recompress-bdd.ps1`（Task 10 已在複本驗證過），回報前後大小。
