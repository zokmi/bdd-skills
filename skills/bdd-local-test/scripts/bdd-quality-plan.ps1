param(
    [string]$Repo = '.',
    [Parameter(Mandatory)][string]$Base,
    [ValidateSet('LOW','MEDIUM','HIGH')][string]$ReviewRisk = 'HIGH',
    [Parameter(Mandatory)][string]$ReviewReason,
    [switch]$StaticPassed,
    [switch]$ImpactComplete,
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

$level = 'FULL'
$reason = '高風險、要求完整驗證或無法可靠界定影響範圍'
if (-not $Full -and $ReviewRisk -ne 'HIGH' -and -not $lint.Count) {
    if ($ReviewRisk -eq 'LOW' -and $StaticPassed -and $docsOnly) {
        $level = 'FAST'
        $reason = '靜態檢查通過且 Review 確認文件異動不影響行為'
    } elseif ($ImpactComplete -and $impact.modules.Count -and -not $impact.unmatched.Count -and -not @($paths -like '.bdd/*').Count) {
        $level = 'TARGETED'
        $reason = '所有異動已對應模組，Review 已核對外溢依賴'
    }
}

$selected = @(foreach ($module in $modules) {
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
