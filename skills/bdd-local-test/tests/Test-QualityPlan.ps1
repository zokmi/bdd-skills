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
            '    When I request the record', '    Then the response is 200',
            "  @$prefix-02 @#2 @core @API", '  Scenario: Read core record',
            '    When I request the core record', '    Then the response is 200',
            "  @$prefix-03 @#10 @API", '  Scenario: Read unrelated record',
            '    When I request the unrelated record', '    Then the response is 200') |
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
    $review = @{ Repo = $repo; Base = 'HEAD'; ReviewRisk = 'MEDIUM'; ReviewReason = 'Fixture review'
        StaticPassed = $true; ImpactComplete = $true }
    $batch = & $planner @review -Issue 1 -ImpactScenario 'src/orders/handler.txt=OR-01' | ConvertFrom-Json
    if ($batch.issueScope -ne 'batch' -or $batch.bddStatus -ne 'PENDING' -or ($batch.selected.scenarios.ids -join ',') -ne 'OR-01') {
        throw 'The default issue batch must use only the reviewed impact mapping'
    }
    $unmappedBatch = & $planner @review -Issue 1 | ConvertFrom-Json
    if ($unmappedBatch.bddStatus -ne 'BLOCKED' -or -not $unmappedBatch.blockers -or $unmappedBatch.selected.Count -ne 0) {
        throw 'A batch with an unmapped source must request impact review'
    }
    $issue = & $planner @review -Issue 1 -IssueScope issue | ConvertFrom-Json
    if ($issue.level -ne 'TARGETED' -or ($issue.selected.scenarios.ids -join ',') -ne 'AC-01,OR-01,OR-02') {
        throw 'Whole-issue selection must include matching issue tags across modules and the affected module core'
    }
    $unknownIssue = & $planner @review -Issue 99 -IssueScope issue | ConvertFrom-Json
    if ($unknownIssue.selected.scenarios.Count -ne 3) { throw 'Unmapped issue must retain the affected module coverage' }
    $full = & $planner @review -Issue 1 -Full | ConvertFrom-Json
    if ($full.level -ne 'FULL' -or @($full.selected | ForEach-Object { $_.scenarios }).Count -ne 6) {
        throw 'FULL must retain all six scenarios'
    }
    Add-Content -LiteralPath (Join-Path $repo '.bdd/modules/api/orders/01-read.feature') -Value '# Reviewed scenario update'
    $updatedIssue = & $planner @review -Issue 1 -IssueScope issue | ConvertFrom-Json
    if ($updatedIssue.level -ne 'TARGETED' -or ($updatedIssue.selected.scenarios.ids -join ',') -ne 'AC-01,OR-01,OR-02') {
        throw 'A local feature edit in an affected module must retain issue selection'
    }
    'earlier feedback in another source' | Set-Content (Join-Path $repo 'src/accounts/handler.txt')
    $paths = @('src/orders/handler.txt', '.bdd/modules/api/orders/01-read.feature')
    $mappings = @('src/orders/handler.txt=OR-01', '.bdd/modules/api/orders/01-read.feature=OR-01')
    $scoped = & $planner @review -Issue 1 -BatchPath $paths -ImpactScenario $mappings | ConvertFrom-Json
    if ($scoped.bddStatus -ne 'PENDING' -or ($scoped.selected.scenarios.ids -join ',') -ne 'OR-01' -or
        $scoped.batchPaths.Count -ne 2 -or $scoped.allChangedPaths -notcontains 'src/accounts/handler.txt') {
        throw 'The PowerShell entry must forward all reviewed batch paths and scenario mappings'
    }
    git -C $repo restore -- 'src/accounts/handler.txt'
    "PASS feedback batch, whole issue, missing mapping, explicit FULL, and local feature update"
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
