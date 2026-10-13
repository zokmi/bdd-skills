<#
.SYNOPSIS
  驗證並彙整指定的並行 BDD 派工。唯讀輸入，只建立新的摘要目錄。
.OUTPUTS
  summary.json、SUMMARY.md；exit 0 = 結構檢查通過（可含測試失敗），1 = 紀錄不可採納，2 = 操作錯誤。
  eligibleForReview 不代表已審核證據或已取得 issue 更新授權。
#>
param(
    [Parameter(Mandatory)][string[]]$AssignmentFiles,
    [Parameter(Mandatory)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
$issues = [Collections.Generic.List[string]]::new()
$rows = [Collections.Generic.List[object]]::new()
$groups = [Collections.Generic.List[object]]::new()
$seen = @{}
$versions = [Collections.Generic.HashSet[string]]::new()
$identities = @{}
$runId = $null
function Read-Contract($Path, $Schema) {
    $raw = Get-Content -LiteralPath $Path -Raw
    if (-not (Test-Json -Json $raw -SchemaFile (Join-Path $PSScriptRoot "../schemas/$Schema.schema.json") -ErrorAction Stop)) { throw "Invalid $Schema schema: $Path" }
    $raw | ConvertFrom-Json -AsHashtable
}
function Resolve-Artifact($Root, $Reference) {
    $relative = ($Reference -split '#', 2)[0]
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '^[A-Za-z]+:' -or -not $relative) { throw "Unsafe artifact path: $Reference" }
    $base = [IO.Path]::GetFullPath($Root)
    $full = [IO.Path]::GetFullPath((Join-Path $base $relative))
    if (-not $full.StartsWith($base.TrimEnd('/','\') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Artifact escapes outputDir: $Reference" }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing artifact: $Reference" }
    # Reject symlink/junction ancestors rather than following them outside the group.
    $item = Get-Item -LiteralPath $full -Force
    while ($item -and $item.FullName.Length -ge $base.Length) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked artifact not accepted: $Reference" }
        $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
    $full
}
try {
    $destination = [IO.Path]::GetFullPath($OutputDir)
    if (Test-Path -LiteralPath $destination) { throw 'OutputDir must be a new directory; existing summaries are never overwritten.' }
    foreach ($file in $AssignmentFiles) {
        $a = Read-Contract $file 'assignment'
        $root = [IO.Path]::GetFullPath($a.outputDir)
        if ($destination.StartsWith($root.TrimEnd('/','\') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $destination -eq $root -or $root.StartsWith($destination.TrimEnd('/','\') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDir must be separate from group outputs.' }
        if ($null -eq $runId) { $runId = $a.runId }
        if ($a.runId -ne $runId) { $issues.Add("Mixed runId: $($a.groupId)") }
        $identity = "$($a.runId)|$($a.groupId)"
        if ($identities.ContainsKey($identity)) { $issues.Add("Duplicate group assignment: $identity") }
        $identities[$identity] = $true
        $group = @{ groupId = $a.groupId; attempt = $a.attempt; assignment = [IO.Path]::GetFullPath($file); result = $null; version = $null }
        $groups.Add($group)
        $resultFile = Join-Path (Split-Path ([IO.Path]::GetFullPath($file))) 'result.json'
        $r = $null
        try {
            $r = Read-Contract (Resolve-Artifact $root ([IO.Path]::GetRelativePath($root, $resultFile))) 'result'
            foreach ($key in @('runId','groupId','attempt')) { if ($r[$key] -ne $a[$key]) { throw "Result identity mismatch: $key" } }
            $group.result = $resultFile
        } catch { $issues.Add("$($a.groupId): $($_.Exception.Message)"); $r = $null }
        $resultMap = @{}
        if ($r) {
            try {
                if ($r.taskStatus -ne 'completed' -or $r.blockers.Count) { $issues.Add("$($a.groupId): Task incomplete or unresolved blockers") }
                if (-not $r.verification) { throw 'Missing verification reference' }
                $v = Get-Content -LiteralPath (Resolve-Artifact $root $r.verification.path) -Raw | ConvertFrom-Json -AsHashtable
                $index = $r.verification.roundIndex
                if ($index -ge @($v.rounds).Count) { throw 'Invalid verification roundIndex' }
                $round = $v.rounds[$index]
                if (-not $round.repo -or -not $round.head) { throw 'Incomplete verification version' }
                if (-not $round.ContainsKey('dirtyPaths') -or $round.dirtyPaths -isnot [array] -or $round.scenarios -isnot [array] -or $round.result -isnot [System.Collections.IDictionary]) { throw 'Incomplete verification round structure' }
                if ($round.head -ne $a.target.head -or $r.execution.serviceVersion -ne $a.target.serviceVersion -or -not $r.execution.serviceVersion) { throw 'Actual version differs from assignment or is unknown' }
                if ($r.execution.uiUrl -ne $a.environment.uiUrl -or $r.execution.apiUrl -ne $a.environment.apiUrl) { throw 'Actual URLs differ from assignment' }
                if (@($round.dirtyPaths).Count -or @($a.target.dirtyPaths).Count) { throw 'Dirty version needs manual snapshot review; cannot automatically accept' }
                # Repo identity follows bdd-verification.ps1; Git calls are read-only.
                $repoRoot = & git -C $a.target.repo rev-parse --show-toplevel 2>$null
                if ($LASTEXITCODE -ne 0) { throw 'Cannot verify assignment repo identity' }
                $workRoot = & git -C $a.target.workDir rev-parse --show-toplevel 2>$null
                if ($LASTEXITCODE -ne 0 -or $workRoot.Trim() -ne $repoRoot.Trim()) { throw 'Assignment workDir differs from repo' }
                $resolvedHead = & git -C $a.target.repo rev-parse --verify "$($round.head)^{commit}" 2>$null
                if ($LASTEXITCODE -ne 0 -or $resolvedHead.Trim() -ne $round.head) { throw 'Recorded HEAD is not an existing full commit SHA' }
                $remotes = @(& git -C $a.target.repo remote)
                $remote = if ($remotes -contains 'origin') { 'origin' } elseif ($remotes.Count) { $remotes[0] } else { $null }
                $url = if ($remote) { (& git -C $a.target.repo remote get-url $remote).Trim() } else { '' }
                if ($round.repo.name -ne (Split-Path $repoRoot.Trim() -Leaf) -or $round.repo.url -ne $url) { throw 'Verification repo differs from assignment' }
                $group.version = @{ repo = $round.repo; head = $round.head; serviceVersion = $r.execution.serviceVersion }
                $versionKey = "$($round.repo.name)|$url|$($round.head)|$($r.execution.serviceVersion)"
                $null = $versions.Add($versionKey)
                $null = Resolve-Artifact $root $r.artifacts.report
                if ($r.artifacts.masking) { $null = Resolve-Artifact $root $r.artifacts.masking }
                foreach ($path in $r.modifiedPaths) {
                    if ([IO.Path]::IsPathRooted($path) -or $path -match '(^|[/\\])\.\.([/\\]|$)') { throw "Unsafe modified path: $path" }
                    if (-not @($a.permissions.editablePaths | Where-Object { $path -like $_ }).Count) { throw "Unauthorized modification: $path" }
                }
                foreach ($s in $r.scenarios) {
                    $key = "$($s.feature)|$($s.id)"
                    if ($resultMap.ContainsKey($key)) { throw "Duplicate result scenario: $key" }
                    $resultMap[$key] = $s
                    if (-not @($round.scenarios | Where-Object { $_.path -eq $s.feature -and $_.role -eq $s.kind -and $_.ids -contains $s.id }).Count) { throw "Scenario absent from verification round: $key" }
                    foreach ($e in $s.evidence) { $null = Resolve-Artifact $root $e }
                    if ($s.status -eq 'passed' -and (-not $s.expected -or -not $s.actual)) { throw "Passed scenario lacks expected/actual: $key" }
                    if ($s.status -eq 'passed' -and @($s.evidence | Where-Object { $_ -match '\.(png|jpe?g|webp|gif)(#|$)' }).Count) {
                        $mask = & (Join-Path $PSScriptRoot 'mask-evidence.ps1') -Dir $root -Status | ConvertFrom-Json
                        foreach ($e in $s.evidence | Where-Object { $_ -match '\.(png|jpe?g|webp|gif)(#|$)' }) {
                            if (-not @($mask.files | Where-Object { $_.file -eq ($e -split '#',2)[0] -and $_.state -eq 'masked' }).Count) { throw "Invalid image masking: $e" }
                        }
                    }
                }
                $statusFields = @{ passed = 'passed'; failed = 'failed'; blocked = 'blocked'; 'not-run' = 'notRun' }
                foreach ($status in $statusFields.Keys) {
                    if ($round.result[$statusFields[$status]] -ne @($r.scenarios | Where-Object status -eq $status).Count) { throw "Verification count mismatch: $status" }
                }
                foreach ($resource in $a.resources) {
                    if (@($r.resourceStates | Where-Object id -eq $resource.id).Count -ne 1) { throw "Missing or duplicate resource state: $($resource.id)" }
                }
                if ($r.rerunScenarios.Count) { throw 'Pending rerun scenarios' }
            } catch {
                $issues.Add("$($a.groupId): $($_.Exception.Message)")
                $resultMap = @{}
                # Known precondition blockers remain blockers even without a tested version.
                foreach ($s in $r.scenarios) {
                    if ($s.status -eq 'blocked' -and $s.reason) { $resultMap["$($s.feature)|$($s.id)"] = $s }
                }
            }
        }
        $assigned = @{}
        foreach ($s in $a.scenarios) {
            $key = "$($s.feature)|$($s.id)"
            if ($assigned.ContainsKey($key)) { $issues.Add("Duplicate assigned scenario: $key") }
            $assigned[$key] = $true
            # Include repo in cross-group identity to avoid collapsing unrelated projects.
            $globalKey = "$($a.target.repo)|$key"
            if ($seen.ContainsKey($globalKey)) { $issues.Add("Repeated cross-group scenario requires manual review: $key"); continue }
            $seen[$globalKey] = $true
            $status = 'not-run'
            if ($resultMap.ContainsKey($key)) {
                $actual = $resultMap[$key]
                if ($actual.kind -ne $s.kind) { $issues.Add("Scenario kind mismatch: $key") }
                else { $status = $actual.status }
            } else { $issues.Add("Missing or unacceptable scenario result: $($a.groupId)/$key") }
            $rows.Add(@{ groupId = $a.groupId; repo = $a.target.repo; feature = $s.feature; id = $s.id; kind = $s.kind; status = $status })
        }
        foreach ($key in $resultMap.Keys) { if (-not $assigned.ContainsKey($key)) { $issues.Add("Unexpected result scenario: $key") } }
    }
    if ($versions.Count -gt 1) { $issues.Add('Multiple tested versions: keep separate; no combined pass eligibility.') }
    $counts = @{ passed = 0; failed = 0; blocked = 0; 'not-run' = 0 }
    foreach ($row in $rows) { $counts[$row.status]++ }
    $eligible = $rows.Count -gt 0 -and $issues.Count -eq 0 -and $counts.passed -eq $rows.Count
    $summary = @{ contractVersion = 1; runId = $runId; eligibleForReview = $eligible; counts = $counts; issues = @($issues); groups = @($groups); scenarios = @($rows); limitation = 'Structural acceptance only: main agent must review evidence content, environment, dependencies and final integration. Resource release is not inferred.' }
    $null = New-Item -ItemType Directory -Path $destination
    $summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $destination 'summary.json') -Encoding utf8
    $lines = @('# Parallel BDD summary', '', "Run: $runId", "Eligible for evidence review: $eligible", "Passed: $($counts.passed); failed: $($counts.failed); blocked: $($counts.blocked); not-run: $($counts['not-run'])", '', 'Main agent must review evidence content and final integration; this is not an all-pass declaration.', '', '## Adoption issues', '')
    $lines += @($issues | ForEach-Object { "- $_" })
    $lines | Set-Content -LiteralPath (Join-Path $destination 'SUMMARY.md') -Encoding utf8
    $summary | ConvertTo-Json -Depth 20
    if ($issues.Count) { exit 1 }; exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
