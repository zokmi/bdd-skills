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
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('quality-plan', "--repo=$Repo", "--base=$Base", "--review-risk=$ReviewRisk", "--review-reason=$ReviewReason")
if ($StaticPassed) { $cliArgs += '--static-passed' }
if ($ImpactComplete) { $cliArgs += '--impact-complete' }
if ($Issue) { $cliArgs += "--issue=$Issue" }
if ($Full) { $cliArgs += '--full' }
& node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
if ($LASTEXITCODE -ne 0) { throw '無法建立 BDD 品質計畫，請檢查上述錯誤。' }
