<#
.SYNOPSIS
  驗證並彙整指定的並行 BDD 派工。唯讀輸入，只建立新的摘要目錄。
.OUTPUTS
  summary.json、SUMMARY.md；exit 0 = 結構檢查通過（可含測試失敗），1 = 紀錄不可採納，2 = 操作錯誤。
  eligibleForReview 不代表已審核證據或已取得 issue 更新授權。
#>
param(
    [string[]]$AssignmentFiles = @(),
    [Parameter(Mandatory)][string]$OutputDir,
    [string]$PlanFile
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('parallel-summary', "--output-dir=$OutputDir")
if ($PlanFile) { $cliArgs += "--plan=$PlanFile" }
foreach ($file in $AssignmentFiles) { $cliArgs += "--assignment=$file" }
& node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
exit $LASTEXITCODE
