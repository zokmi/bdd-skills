<#
.SYNOPSIS
  記錄 BDD 實測當下的 git 版本（-Record），或比對既有紀錄與目前 repo 是否仍一致（-Check），
  讓報告跟著 cherry-pick／merge 同步到別的分支或別的 repo 時，能判斷要不要重新驗證。

.DESCRIPTION
  紀錄檔是輸出資料夾裡的 verification.json，與 REPORT.md 一起進版控、一起被同步。
  每一輪實測結束時 -Record 追加一筆 rounds；-Check 讀最後一筆，與目前 repo 比對：

    - repo 是否相同（origin URL）
    - 紀錄的 HEAD 是否就是目前 HEAD、相關檔案有沒有未提交異動
    - 每個受測 commit 在目前 repo 的對應：
        same     同一個 SHA 且是目前 HEAD 的祖先
        patch    SHA 不同但 patch-id 相同（cherry-pick 過來，內容一致）
        subject  只找到同標題的 commit，內容有差異（通常是解衝突或手動改寫）
        missing  找不到，這個異動沒有同步過來
    - 受測檔案在目前 HEAD 的 blob 是否與紀錄時相同
    - 本輪跑過的模組情境檔（scenarios）在目前 HEAD 的 blob 是否與紀錄時相同

  判定（verdict）：
    current       同 repo、同 HEAD、相關檔案無未提交異動 → 報告仍有效
    still-valid   同 repo、HEAD 前進了，但受測 commit 都在、受測檔案內容未變 → 報告仍有效，註記新 HEAD 即可
    rerun         其餘情況（跨 repo、cherry-pick、檔案有變、有 commit 缺漏）→ 必須重新驗證

.PARAMETER Dir
  BDD 輸出資料夾（例如 .bdd/94541-resign-rollback-detach）。

.PARAMETER Record
  記錄模式。需搭配 -Base 或 -Commits。

.PARAMETER Check
  比對模式。

.PARAMETER Base
  記錄模式：受測範圍的基準（取 Base..Head 的非 merge commit）。

.PARAMETER Commits
  記錄模式：直接指定受測 commit（逗號分隔），優先於 -Base。

.PARAMETER Head
  記錄模式：受測版本，預設 HEAD。

.PARAMETER Passed / Failed / Blocked / NotRun
  記錄模式：本輪各結果的情境數。

.PARAMETER Note
  記錄模式：本輪的一句說明（例如「自 upstream 同步後複測」）。

.PARAMETER ChangedScenarios
  記錄模式：本輪新增或修改的模組情境檔（repo 相對路徑）。每項可寫「<路徑>」或「<路徑>::<編號>,<編號>」，未列編號時取檔內所有情境；可用 ; 串多項。

.PARAMETER RegressionScenarios
  記錄模式：本輪沒有修改、挑來回歸的模組情境檔，格式同 -ChangedScenarios。

.PARAMETER SearchDepth
  比對模式：以 patch-id／標題搜尋對應 commit 時，往回找的 commit 數上限，預設 3000。

.OUTPUTS
  JSON。-Check 的 exit code：0 = current／still-valid、1 = rerun、2 = 紀錄不存在或參數錯誤。

.EXAMPLE
  pwsh -File bdd-verification.ps1 -Record -Dir .bdd/94541-x -Base develop -Passed 28
  pwsh -File bdd-verification.ps1 -Check -Dir .bdd/94541-x
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [switch]$Record,
    [switch]$Check,
    [string]$Base,
    [string[]]$Commits = @(),
    [string]$Head = 'HEAD',
    [int]$Passed = 0,
    [int]$Failed = 0,
    [int]$Blocked = 0,
    [int]$NotRun = 0,
    [string]$Note = '',
    [string[]]$ChangedScenarios = @(),
    [string[]]$RegressionScenarios = @(),
    [int]$SearchDepth = 3000
)

$ErrorActionPreference = 'Stop'
# git 輸出為 UTF-8；不設定的話中文 commit 標題會亂碼，跨機器比對標題時就對不上
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
# 中文檔名不要被 git 轉成 \345\256... 的八進位跳脫
$env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'core.quotepath'; $env:GIT_CONFIG_VALUE_0 = 'off'
Import-Module (Join-Path $PSScriptRoot 'lib/BddModules.psm1') -Force
$file = Join-Path $Dir 'verification.json'

# 取得 repo 識別：origin URL（沒有 origin 就用第一個 remote），再加上根目錄名稱
function Get-RepoIdentity {
    $root = (git rev-parse --show-toplevel).Trim()
    $url = ''
    $remotes = @(git remote)
    if ($remotes -contains 'origin') { $url = (git remote get-url origin).Trim() }
    elseif ($remotes.Count -gt 0) { $url = (git remote get-url $remotes[0]).Trim() }
    [ordered]@{ name = (Split-Path $root -Leaf); url = $url }
}

# 計算單一 commit 的 stable patch-id（跨 repo cherry-pick 後仍相同）
function Get-PatchId([string]$sha) {
    $line = git show --format= $sha | git patch-id --stable
    if (-not $line) { return '' }
    ($line -split '\s+')[0]
}

# 正規化 URL 以比對 repo（忽略大小寫、結尾 .git 與斜線）
function Format-RepoUrl([string]$url) {
    $url.Trim().ToLowerInvariant() -replace '\.git$', '' -replace '/+$', ''
}

# 列出相關檔案的未提交異動（排除 .bdd 自己）
function Get-DirtyPaths([string[]]$paths) {
    if ($paths.Count -eq 0) { return @() }
    $root = (git rev-parse --show-toplevel).Trim()
    @(git -C $root status --porcelain -- @paths | ForEach-Object { $_.Substring(3) })
}

# 把 -ChangedScenarios／-RegressionScenarios 的每一項轉成紀錄：path、blob（受測版本的 git blob；該版本沒有此檔為 null）、ids、role
function ConvertTo-ScenarioRecords([string[]]$Entries, [string]$Role, [string]$HeadSha) {
    $root = (git rev-parse --show-toplevel).Trim()
    foreach ($entry in @($Entries | ForEach-Object { $_ -split ';' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $parts = $entry -split '::', 2
        $path = ($parts[0] -replace '\\', '/') -replace '^\./', ''
        $full = Join-Path $root $path
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "找不到情境檔：$path" }
        $blob = git rev-parse --verify --quiet "${HeadSha}:$path"
        $ids = if ($parts.Count -gt 1) { @($parts[1] -split '[,\s]+' | Where-Object { $_ }) }
               else { @(Get-FeatureScenarios $full | ForEach-Object { $_.ids }) }
        [ordered]@{ path = $path; blob = if ($blob) { "$blob".Trim() } else { $null }; ids = @($ids); role = $Role }
    }
}

if ($Record -eq $Check) { Write-Error '請擇一指定 -Record 或 -Check'; exit 2 }

if ($Record) {
    $headSha = (git rev-parse $Head).Trim()
    $commitList = @($Commits | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ })
    if ($commitList.Count -eq 0) {
        if (-not $Base) { Write-Error '記錄模式需要 -Base 或 -Commits'; exit 2 }
        $commitList = @(git rev-list --no-merges --reverse "$Base..$headSha")
    }

    $commitInfo = foreach ($c in $commitList) {
        $sha = (git rev-parse "$c^{commit}").Trim()
        [ordered]@{
            sha     = $sha
            patchId = Get-PatchId $sha
            subject = (git log -1 --format=%s $sha).Trim()
        }
    }

    # 受測檔案：所有受測 commit 動到的檔案（排除 .bdd），記下它們在受測版本的 blob
    $paths = @($commitInfo | ForEach-Object { git show --name-only --format= $_.sha } |
        Where-Object { $_ -and $_ -notmatch '^\.bdd/' } | Sort-Object -Unique)
    $blobs = [ordered]@{}
    foreach ($p in $paths) {
        $b = git rev-parse --verify --quiet "${headSha}:$p"
        $blobs[$p] = if ($b) { $b.Trim() } else { $null }   # null 代表該檔在受測版本已刪除
    }

    try {
        $scenarioRecords = @(
            ConvertTo-ScenarioRecords $ChangedScenarios 'changed' $headSha
            ConvertTo-ScenarioRecords $RegressionScenarios 'regression' $headSha
        )
    } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
    $scenarioPaths = @($scenarioRecords | ForEach-Object { $_.path })

    $round = [ordered]@{
        recordedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
        repo       = Get-RepoIdentity
        branch     = (git branch --show-current).Trim()
        head       = $headSha
        base       = if ($Base) { (git rev-parse $Base).Trim() } else { $null }
        baseRef    = $Base
        dirtyPaths = @(Get-DirtyPaths (@($paths) + $scenarioPaths))
        commits    = @($commitInfo)
        files      = $blobs
        scenarios  = $scenarioRecords
        result     = [ordered]@{ passed = $Passed; failed = $Failed; blocked = $Blocked; notRun = $NotRun }
        note       = $Note
    }

    $doc = if (Test-Path $file) { Get-Content $file -Raw | ConvertFrom-Json -AsHashtable } else { [ordered]@{ rounds = @() } }
    $doc.rounds = @($doc.rounds) + $round
    $doc | ConvertTo-Json -Depth 8 | Set-Content -Path $file -Encoding utf8NoBOM
    $round | ConvertTo-Json -Depth 8
    exit 0
}

# ---- 比對模式 ----
if (-not (Test-Path $file)) {
    [ordered]@{ verdict = 'no-record'; reasons = @("找不到 $file，視為從未記錄，須重新驗證") } | ConvertTo-Json
    exit 2
}

$doc = Get-Content $file -Raw | ConvertFrom-Json -AsHashtable
$last = @($doc.rounds)[-1]
$cur = Get-RepoIdentity
$headSha = (git rev-parse HEAD).Trim()
$reasons = [System.Collections.Generic.List[string]]::new()

$sameRepo = (Format-RepoUrl $cur.url) -eq (Format-RepoUrl $last.repo.url)
if (-not $sameRepo) { $reasons.Add("repo 不同：紀錄於 $($last.repo.name)（$($last.repo.url)），目前為 $($cur.name)（$($cur.url)）") }

# 先建立近期 commit 的 patch-id／標題索引，只在有 commit 找不到同 SHA 時才計算
$index = $null
function Get-Index {
    if ($null -ne $script:index) { return $script:index }
    $byPatch = @{}; $bySubject = @{}
    $filePaths = @($last.files.Keys)
    $shas = if ($filePaths.Count -gt 0) {
        @(git log --no-merges --format=%H -n $SearchDepth HEAD -- @filePaths)
    } else { @(git log --no-merges --format=%H -n $SearchDepth HEAD) }
    foreach ($s in $shas) {
        $pid_ = Get-PatchId $s
        if ($pid_ -and -not $byPatch.ContainsKey($pid_)) { $byPatch[$pid_] = $s }
        $subj = (git log -1 --format=%s $s).Trim()
        if (-not $bySubject.ContainsKey($subj)) { $bySubject[$subj] = $s }
    }
    $script:index = @{ patch = $byPatch; subject = $bySubject }
    $script:index
}

$mapping = foreach ($c in $last.commits) {
    $status = 'missing'; $target = $null
    $exists = git cat-file -e "$($c.sha)^{commit}" 2>$null; $found = ($LASTEXITCODE -eq 0)
    if ($found) {
        git merge-base --is-ancestor $c.sha $headSha 2>$null
        if ($LASTEXITCODE -eq 0) { $status = 'same'; $target = $c.sha }
    }
    if ($status -eq 'missing') {
        $idx = Get-Index
        if ($c.patchId -and $idx.patch.ContainsKey($c.patchId)) { $status = 'patch'; $target = $idx.patch[$c.patchId] }
        elseif ($idx.subject.ContainsKey($c.subject)) { $status = 'subject'; $target = $idx.subject[$c.subject] }
    }
    [ordered]@{ source = $c.sha; target = $target; status = $status; subject = $c.subject }
}
$mapping = @($mapping)

$cherry = @($mapping | Where-Object { $_.status -eq 'patch' }).Count
$rewritten = @($mapping | Where-Object { $_.status -eq 'subject' })
$missing = @($mapping | Where-Object { $_.status -eq 'missing' })
if ($cherry -gt 0) { $reasons.Add("$cherry 個受測 commit 以 cherry-pick 形式存在（SHA 不同、內容相同）") }
if ($rewritten.Count -gt 0) { $reasons.Add("$($rewritten.Count) 個受測 commit 只找到同標題的 commit，內容有差異：" + (($rewritten | ForEach-Object { $_.subject }) -join '；')) }
if ($missing.Count -gt 0) { $reasons.Add("$($missing.Count) 個受測 commit 在目前 repo 找不到：" + (($missing | ForEach-Object { $_.subject }) -join '；')) }

# 受測檔案內容比對
$changedFiles = foreach ($p in $last.files.Keys) {
    $b = git rev-parse --verify --quiet "${headSha}:$p"
    $b = if ($b) { $b.Trim() } else { $null }
    if ($b -ne $last.files[$p]) { $p }
}
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
if ($changedFiles.Count -gt 0) { $reasons.Add("$($changedFiles.Count) 個受測檔案內容與受測時不同") }
if ($dirty.Count -gt 0) { $reasons.Add("$($dirty.Count) 個受測檔案有未提交異動") }

$verdict = if ($reasons.Count -gt 0) { 'rerun' }
           elseif ($headSha -eq $last.head) { 'current' }
           else { 'still-valid' }

[ordered]@{
    verdict      = $verdict
    reasons      = @($reasons)
    recorded     = [ordered]@{ repo = $last.repo; branch = $last.branch; head = $last.head; recordedAt = $last.recordedAt; result = $last.result }
    current      = [ordered]@{ repo = $cur; branch = (git branch --show-current).Trim(); head = $headSha }
    commits      = $mapping
    changedFiles = $changedFiles
    changedScenarios = $changedScenarios
    dirtyPaths   = $dirty
} | ConvertTo-Json -Depth 8

exit ($(if ($verdict -eq 'rerun') { 1 } else { 0 }))
