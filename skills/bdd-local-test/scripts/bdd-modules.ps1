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
