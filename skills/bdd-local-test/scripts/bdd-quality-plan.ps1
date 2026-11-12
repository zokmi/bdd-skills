param(
    [string]$Repo = '.',
    [Parameter(Mandatory)][string]$Base,
    [ValidateSet('LOW','MEDIUM','HIGH')][string]$ReviewRisk = 'HIGH',
    [Parameter(Mandatory)][string]$ReviewReason,
    [switch]$StaticPassed,
    [switch]$ImpactComplete,
    [ValidatePattern('^[0-9]+$')][string]$Issue,
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/BddModules.psm1') -Force
$root = (git -C $Repo rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { throw '無法取得 Git 工作區' }
$head = (git -C $root rev-parse --verify HEAD)
if ($LASTEXITCODE -ne 0) { throw '無法取得候選 HEAD' }
$baseline = (git -C $root rev-parse --verify --end-of-options "$Base^{commit}")
if ($LASTEXITCODE -ne 0) { throw '無法取得基準 commit' }

$paths = foreach ($range in @("$baseline...$head", $head)) {
    git -C $root -c core.quotepath=false diff --no-renames --name-only $range --
    if ($LASTEXITCODE -ne 0) { throw '無法取得 Git 差異' }
}
$staged = @(git -C $root -c core.quotepath=false diff --cached --no-renames --name-only $head --)
if ($LASTEXITCODE -ne 0) { throw '無法取得暫存區差異' }
$untracked = @(git -C $root -c core.quotepath=false ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw '無法列出未追蹤檔案' }
$paths = @((@($paths) + $staged + $untracked) | Where-Object { $_ } | Sort-Object -Unique)
$impact = Find-ModulesForPaths -RepoRoot $root -Paths $paths
$modules = @(Get-BddModules $root)
$lint = @(Test-BddModules $root)
$docsOnly = @($paths | Where-Object { $_ -cnotmatch '^(README\.md|docs/[\w/.-]+\.md)$' }).Count -eq 0
$requiresFullBdd = @($paths -clike '.bdd/*' | Where-Object {
    -not ($Issue -and $_ -cmatch '^\.bdd/modules/(?<module>[^/]+/[^/]+)/[^/]+\.feature$' -and
        $Matches.module -cin $impact.modules.name -and (Test-Path -LiteralPath (Join-Path $root $_) -PathType Leaf))
}).Count -gt 0

$level = 'FULL'
$reason = '高風險、要求完整驗證或無法可靠界定影響範圍'
if (-not $Full -and $ReviewRisk -ne 'HIGH' -and -not $lint.Count) {
    if ($ReviewRisk -eq 'LOW' -and $StaticPassed -and $docsOnly) {
        $level = 'FAST'
        $reason = '靜態檢查通過且 Review 確認文件異動不影響行為'
    } elseif ($ImpactComplete -and $impact.modules.Count -and -not $impact.unmatched.Count -and -not $requiresFullBdd) {
        $level = 'TARGETED'
        $reason = '所有異動已對應模組，Review 已核對外溢依賴'
    }
}

$candidates = @(foreach ($module in $modules) {
    if ($level -eq 'FAST' -or ($level -eq 'TARGETED' -and $module.name -notin $impact.modules.name)) { continue }
    foreach ($feature in Get-ChildItem -LiteralPath $module.dir -File -Filter '*.feature') {
        [ordered]@{
            module = $module.name
            feature = [IO.Path]::GetRelativePath($root, $feature.FullName).Replace('\', '/')
            sha256 = (Get-FileHash -LiteralPath $feature.FullName).Hash
            scenarios = @(Get-FeatureScenarios $feature.FullName | Select-Object line, title, ids, tags, methods)
            reason = $reason
        }
    }
})
$selected = @(foreach ($group in ($candidates | Group-Object module)) {
    $features = @($group.Group)
    $scenarios = @($features | ForEach-Object { $_.scenarios })
    $issueTag = "@#$Issue"
    $hasIssue = @($scenarios | Where-Object { $_.tags -ccontains $issueTag }).Count -gt 0
    $hasCore = @($scenarios | Where-Object { $_.tags -ccontains '@core' }).Count -gt 0
    $hasUnindexedFeature = @($features | Where-Object { -not $_.scenarios.Count }).Count -gt 0
    if ($level -ne 'TARGETED' -or -not $Issue -or -not $hasIssue -or -not $hasCore -or $hasUnindexedFeature) {
        $features
        continue
    }
    foreach ($feature in $features) {
        $feature.scenarios = @($feature.scenarios | Where-Object {
            $_.tags -ccontains $issueTag -or $_.tags -ccontains '@core'
        })
        if ($feature.scenarios.Count) {
            $feature.reason = "已核對影響範圍，選取 $issueTag 與 @core"
            $feature
        }
    }
})
[ordered]@{
    head = $head
    base = $baseline
    paths = $paths
    risk = $ReviewRisk
    reviewReason = $ReviewReason
    staticPassed = [bool]$StaticPassed
    level = $level
    reason = $reason
    unmatched = $impact.unmatched
    lint = $lint
    selected = $selected
    bddStatus = if (-not $StaticPassed -or $lint.Count -or ($level -ne 'FAST' -and -not $selected.Count)) { 'BLOCKED' }
                elseif ($level -eq 'FAST') { 'SKIPPED' }
                else { 'PENDING' }
} | ConvertTo-Json -Depth 10
