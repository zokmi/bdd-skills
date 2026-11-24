<#
.SYNOPSIS
  檢查 BDD 版控規則，預設補齊根目錄 .gitignore；-Check 僅檢查。
.OUTPUTS
  JSON；0 = 通過，1 = 缺漏、衝突或已有追蹤產物，2 = 執行錯誤。
#>
param([string]$Repo = '.', [switch]$Check)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $repoPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Repo)
    $cliArgs = @('gitignore', "--repo=$repoPath")
    if ($Check) { $cliArgs += '--check' }
    & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
    exit $LASTEXITCODE
} catch {
    [ordered]@{ error = $_.Exception.Message } | ConvertTo-Json
    exit 2
}
