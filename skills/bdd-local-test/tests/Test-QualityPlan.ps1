$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$planner = Join-Path $PSScriptRoot '../scripts/bdd-quality-plan.ps1'
$repo = Join-Path ([IO.Path]::GetTempPath()) "bdd-quality-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $repo | Out-Null
try {
    git -C $repo init -q
    foreach ($name in 'orders', 'accounts') {
        $prefix = $name.Substring(0, 2).ToUpperInvariant()
        $module = Join-Path $repo ".bdd/modules/api/$name"
        New-Item -ItemType Directory -Path $module -Force | Out-Null
        @('---', "prefix: $prefix", 'paths:', "  - src/$name/**", '---') |
            Set-Content (Join-Path $module 'MODULE.md')
        @("Feature: $name", "  @$prefix-01 @#1 @API", '  Scenario: Read record',
            '    When I request the record', '    Then the response is 200') |
            Set-Content (Join-Path $module '01-read.feature')
        $source = Join-Path $repo "src/$name"
        New-Item -ItemType Directory -Path $source -Force | Out-Null
        'original' | Set-Content (Join-Path $source 'handler.txt')
    }
    git -C $repo add .
    git -C $repo -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm baseline
    function Assert-Plan($level, $count, $status, $risk) {
        $plan = & $planner -Repo $repo -Base HEAD -ReviewRisk $risk -ReviewReason 'Fixture review' -StaticPassed -ImpactComplete | ConvertFrom-Json
        if ($plan.level -ne $level -or $plan.selected.Count -ne $count -or $plan.bddStatus -ne $status) {
            throw ($plan | ConvertTo-Json -Depth 10)
        }
        "PASS $risk $level $status ($count features)"
    }
    'docs' | Set-Content (Join-Path $repo 'README.md')
    Assert-Plan FAST 0 SKIPPED LOW
    Remove-Item -LiteralPath (Join-Path $repo 'README.md')
    'updated' | Set-Content (Join-Path $repo 'src/orders/handler.txt')
    Assert-Plan TARGETED 1 PENDING MEDIUM
    Assert-Plan FULL 2 PENDING HIGH
    'changed' | Set-Content (Join-Path $repo '.bdd/config.json')
    Assert-Plan FULL 2 PENDING MEDIUM
    Remove-Item -LiteralPath (Join-Path $repo '.bdd/config.json')
    'shared' | Set-Content (Join-Path $repo 'shared.txt')
    Assert-Plan FULL 2 PENDING MEDIUM
} finally {
    # Remove only the uniquely named fixture directory created above.
    $resolved = (Resolve-Path -LiteralPath $repo).Path
    $temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
    if ((Split-Path -Parent $resolved) -eq $temp -and (Split-Path -Leaf $resolved) -match '^bdd-quality-[0-9a-f-]{36}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
