<#
.SYNOPSIS
  檢查 BDD 版控規則，預設補齊根目錄 .gitignore；-Check 僅檢查。
.OUTPUTS
  JSON；0 = 通過，1 = 缺漏、衝突或已有追蹤產物，2 = 執行錯誤。
#>
param([string]$Repo = '.', [switch]$Check)
$ErrorActionPreference = 'Stop'

try {
    $root = git -C $Repo rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Repo must be a Git working tree.' }
    $root = "$root".Trim()
    $ignore = Join-Path $root '.gitignore'
    $begin = '# BEGIN bdd-skills managed ignores'
    $end = '# END bdd-skills managed ignores'
    $rules = @('/.bdd/', '!/.bdd/', '/.bdd/*', '!/.bdd/modules/', '!/.bdd/config.json',
        '/.bdd/modules/**/*', '!/.bdd/modules/**/', '!/.bdd/modules/**/*.feature', '!/.bdd/modules/**/MODULE.md')
    function Test-BddSource([string]$Path) {
        $Path -ceq '.bdd/config.json' -or
        ($Path -cmatch '^\.bdd/modules/(?:.*/)?(?:[^/]+\.feature|MODULE\.md)$')
    }
    function Get-BddFailures {
        $paths = @('.bdd/__bdd_ignore_probe__/REPORT.md', '.bdd/__bdd_ignore_probe__/shot.png',
            '.bdd/modules/__bdd_ignore_probe__/case.feature', '.bdd/modules/__bdd_ignore_probe__/MODULE.md',
            '.bdd/modules/__bdd_ignore_probe__/log.txt', '.bdd/modules/root.feature', '.bdd/config.json')
        $actual = @(git -c core.quotepath=false -C $root ls-files --cached --others -- .bdd/)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate BDD paths.' }
        foreach ($path in @($paths + $actual | Sort-Object -Unique)) {
            $detail = @(git -c core.quotepath=false -C $root check-ignore --no-index -v -- $path)
            if ($LASTEXITCODE -notin 0, 1) { throw 'git check-ignore failed.' }
            # -v also reports matching negations; query -q for the effective result.
            git -C $root check-ignore --no-index -q -- $path
            if ($LASTEXITCODE -notin 0, 1) { throw 'git check-ignore failed.' }
            $ignored = $LASTEXITCODE -eq 0
            if ($ignored -eq (Test-BddSource $path)) {
                [pscustomobject]@{ path = $path; expectedIgnored = -not (Test-BddSource $path); rule = $detail }
            }
        }
    }
    $tracked = @(git -c core.quotepath=false -C $root ls-files -- .bdd/)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked BDD paths.' }
    $trackedOutputs = @($tracked | Where-Object { -not (Test-BddSource $_) })
    $failures = @(Get-BddFailures)
    $updated = $false
    if ($failures.Count -gt 0 -and -not $Check) {
        if (Test-Path -LiteralPath $ignore -PathType Container) { throw '.gitignore is a directory.' }
        if ((Test-Path -LiteralPath $ignore) -and (Get-Item -Force -LiteralPath $ignore).LinkType) { throw 'Refusing to edit a linked .gitignore.' }
        $existed = Test-Path -LiteralPath $ignore
        $bytes = if ($existed) { [IO.File]::ReadAllBytes($ignore) } else { [byte[]]@() }
        $content = if ($existed) { [IO.File]::ReadAllText($ignore) } else { '' }
        if ($content.Contains($begin) -or $content.Contains($end)) {
            throw 'Managed ignore block exists but validation fails; inspect conflicting rules before editing.'
        }
        $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
        $block = (($begin, $rules, $end | ForEach-Object { $_ }) -join $newline) + $newline
        $prefix = if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $newline } else { '' }
        try {
            # Append bytes to preserve the original file, including its BOM and line endings.
            $addition = [Text.UTF8Encoding]::new($false).GetBytes($prefix + $block)
            [IO.File]::WriteAllBytes($ignore, [byte[]]($bytes + $addition))
            $failures = @(Get-BddFailures)
            if ($failures.Count -gt 0) { throw 'Conflicting nested ignore rules; automatic changes rolled back.' }
            $updated = $true
        } catch {
            if ($existed) { [IO.File]::WriteAllBytes($ignore, $bytes) }
            else { Remove-Item -LiteralPath $ignore -Force }
            throw
        }
    }
    [ordered]@{ repo = $root; updated = $updated; failures = $failures; trackedOutputs = $trackedOutputs } | ConvertTo-Json -Depth 6
    if ($failures.Count -gt 0 -or $trackedOutputs.Count -gt 0) { exit 1 }
    exit 0
} catch {
    [ordered]@{ error = $_.Exception.Message } | ConvertTo-Json
    exit 2
}
