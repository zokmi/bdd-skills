param(
    [string]$Repo = '.',
    [Parameter(Mandatory)][string]$Base,
    [ValidateSet('LOW','MEDIUM','HIGH')][string]$ReviewRisk,
    [Parameter(Mandatory)][string]$ReviewReason,
    [switch]$StaticPassed,
    [switch]$ImpactComplete,
    [ValidatePattern('^[0-9]+$')][string]$Issue,
    [switch]$Full,
    [string[]]$ImpactScenario,
    [ValidateSet('batch','issue')][string]$IssueScope,
    [string[]]$BatchPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('quality-plan', "--repo=$Repo", "--base=$Base", "--review-reason=$ReviewReason")
if ($PSBoundParameters.ContainsKey('ReviewRisk')) { $cliArgs += "--review-risk=$ReviewRisk" }
if ($StaticPassed) { $cliArgs += '--static-passed' }
if ($ImpactComplete) { $cliArgs += '--impact-complete' }
if ($Issue) { $cliArgs += "--issue=$Issue" }
if ($PSBoundParameters.ContainsKey('IssueScope')) { $cliArgs += "--issue-scope=$IssueScope" }
foreach ($p in $BatchPath) { $cliArgs += "--batch-path=$p" }
foreach ($mapping in $ImpactScenario) { $cliArgs += "--impact-scenario=$mapping" }
if ($Full) { $cliArgs += '--full' }
& node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
if ($LASTEXITCODE -ne 0) { throw '無法建立 BDD 品質計畫，請檢查上述錯誤。' }
