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
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('modules', "--repo=$Repo")
if ($Lint) { $cliArgs += '--lint' }
if ($NextId) { $cliArgs += '--next-id' }
if ($Module) { $cliArgs += "--module=$Module" }
if ($PSBoundParameters.ContainsKey('ForPaths')) {
    $cliArgs += '--path='
    foreach ($p in $ForPaths) { $cliArgs += "--path=$p" }
}
if ($PSBoundParameters.ContainsKey('Base')) { $cliArgs += "--base=$Base" }
& node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
exit $LASTEXITCODE
