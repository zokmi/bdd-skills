# Standalone integration checks; requires PowerShell 7.4+ and git, no Pester.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../scripts/summarize-parallel-bdd.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('bdd-parallel-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $temp
function Save($Path, $Value) { $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding utf8 }
try {
    $repo = Join-Path $temp 'repo'
    $null = New-Item -ItemType Directory -Path $repo
    git -C $repo init -q
    git -C $repo -c user.name=BDDTest -c user.email=bdd@example.invalid commit --allow-empty -q -m fixture
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create fixture commit' }
    $doc = Get-Content (Join-Path $PSScriptRoot '../references/parallel-bdd-contract.md') -Raw
    $blocks = [regex]::Matches($doc, '(?s)```json\s*\r?\n(.*?)\r?\n```')
    $schemaNames = @('assignment', 'result', 'resource-release')
    for ($i = 0; $i -lt $schemaNames.Count; $i++) {
        $schema = Join-Path $PSScriptRoot "../schemas/$($schemaNames[$i]).schema.json"
        if (-not (Test-Json -Json $blocks[$i].Groups[1].Value -SchemaFile $schema -ErrorAction Stop)) { throw "Invalid $($schemaNames[$i]) example" }
    }
    'PASS all contract schemas'
    $a = $blocks[0].Groups[1].Value | ConvertFrom-Json -AsHashtable
    $r = $blocks[1].Groups[1].Value | ConvertFrom-Json -AsHashtable
    $root = Join-Path $temp 'group'
    $coord = Join-Path $root 'coordination/attempt-1'
    $null = New-Item -ItemType Directory -Path $coord -Force
    $a.target.repo = $repo; $a.target.workDir = $repo; $a.outputDir = $root
    $a.target.head = (git -C $repo rev-parse HEAD).Trim()
    $r.artifacts.masking = $null
    $r.scenarios[0].evidence = @('REPORT.md#ss-13')
    Set-Content (Join-Path $root 'REPORT.md') "# SS-13`n真實 API 證據（測試 fixture）"
    $v = @{ rounds = @(@{ repo = @{ name = 'repo'; url = '' }; head = $a.target.head; dirtyPaths = @(); scenarios = @(@{ path = $a.scenarios[0].feature; ids = @('SS-13'); role = 'changed' }); result = @{ passed = 1; failed = 0; blocked = 0; notRun = 0 } }) }
    Save (Join-Path $root 'verification.json') $v
    Save (Join-Path $coord 'assignment.json') $a
    function Run-Case($Name, $ExpectedCode, $Eligible) {
        $output = & pwsh -NoProfile -File $scriptPath -AssignmentFiles (Join-Path $coord 'assignment.json') -OutputDir (Join-Path $temp $Name) 2>&1
        if ($LASTEXITCODE -ne $ExpectedCode) { throw "$Name expected exit $ExpectedCode, got $LASTEXITCODE : $output" }
        $summary = Get-Content (Join-Path $temp "$Name/summary.json") -Raw | ConvertFrom-Json
        if ($summary.eligibleForReview -ne $Eligible) { throw "$Name eligibility mismatch" }
        "PASS $Name"
    }
    Save (Join-Path $coord 'result.json') $r
    Run-Case 'valid' 0 $true
    $r.taskStatus = 'interrupted'; Save (Join-Path $coord 'result.json') $r
    Run-Case 'incomplete-task' 1 $false
    $r.taskStatus = 'completed'
    $r.attempt = 2; Save (Join-Path $coord 'result.json') $r
    Run-Case 'stale-attempt' 1 $false
    $r.attempt = 1; $r.scenarios[0].evidence = @('../outside.json'); Save (Join-Path $coord 'result.json') $r
    Run-Case 'path-escape' 1 $false
    $r.scenarios[0].evidence = @('missing.json'); Save (Join-Path $coord 'result.json') $r
    Run-Case 'missing-evidence' 1 $false
    $r.scenarios[0].evidence = @('REPORT.md#ss-13'); $r.execution.serviceVersion = 'old-build'; Save (Join-Path $coord 'result.json') $r
    Run-Case 'wrong-version' 1 $false
    $r.execution.serviceVersion = $a.target.serviceVersion; $r.scenarios[0].status = 'green'; Save (Join-Path $coord 'result.json') $r
    Run-Case 'invalid-status' 1 $false
    Remove-Item -LiteralPath (Join-Path $coord 'result.json')
    Run-Case 'interrupted-no-result' 1 $false
    $summary = Get-Content (Join-Path $temp 'interrupted-no-result/summary.json') -Raw | ConvertFrom-Json
    if ($summary.counts.'not-run' -ne 1) { throw 'Missing result must count as not-run' }
    $r.scenarios[0].status = 'passed'; Save (Join-Path $coord 'result.json') $r
    $v.rounds[0].dirtyPaths = @('src/login.cs'); Save (Join-Path $root 'verification.json') $v
    Run-Case 'dirty-version' 1 $false
    $v.rounds[0].dirtyPaths = @(); $v.rounds[0].result.passed = 2; Save (Join-Path $root 'verification.json') $v
    Run-Case 'wrong-count' 1 $false
    $v.rounds[0].result.passed = 1; Save (Join-Path $root 'verification.json') $v
    $r.scenarios += $r.scenarios[0].Clone(); Save (Join-Path $coord 'result.json') $r
    Run-Case 'duplicate-result' 1 $false
    $r.scenarios = @($r.scenarios[0]); Save (Join-Path $coord 'result.json') $r
    $v.rounds[0].Remove('dirtyPaths'); Save (Join-Path $root 'verification.json') $v
    Run-Case 'missing-dirty-paths' 1 $false
    $v.rounds[0].dirtyPaths = @(); $v.rounds[0].head = '1111111111111111111111111111111111111111'; $a.target.head = $v.rounds[0].head
    Save (Join-Path $root 'verification.json') $v; Save (Join-Path $coord 'assignment.json') $a
    Run-Case 'nonexistent-commit' 1 $false
    $r.taskStatus = 'blocked'; $r.verification = $null; $r.scenarios[0].status = 'blocked'; $r.scenarios[0].reason = 'Missing account'; $r.scenarios[0].evidence = @()
    $r.blockers = @(@{ reason = 'Missing account'; scenarioIds = @('SS-13'); resolution = 'Provide authorized test account' })
    Save (Join-Path $coord 'result.json') $r
    Run-Case 'known-blocker' 1 $false
    $summary = Get-Content (Join-Path $temp 'known-blocker/summary.json') -Raw | ConvertFrom-Json
    if ($summary.counts.blocked -ne 1) { throw 'Known blocker must retain blocked status' }
    'All parallel BDD integration checks passed'
} finally {
    # Only remove the uniquely created temporary fixture directory.
    $resolved = [IO.Path]::GetFullPath($temp)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'bdd-parallel-*') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
