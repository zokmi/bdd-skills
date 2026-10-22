$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '../scripts/ensure-bdd-gitignore.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-ignore-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $fixture
function Run-Check([int]$Expected, [switch]$CheckOnly) {
    $arguments = @('-NoProfile', '-File', $script, '-Repo', $fixture)
    if ($CheckOnly) { $arguments += '-Check' }
    $result = & pwsh @arguments | ConvertFrom-Json
    if ($LASTEXITCODE -ne $Expected) { throw "Expected $Expected, got $LASTEXITCODE : $($result | ConvertTo-Json -Depth 6)" }
    $result
}
try {
    git -C $fixture init -q
    $null = Run-Check 1 -CheckOnly
    if (Test-Path "$fixture/.gitignore") { throw 'Check mode wrote a file' }
    $result = Run-Check 0
    if (-not $result.updated) { throw 'Missing rules were not installed' }
    $before = [IO.File]::ReadAllBytes("$fixture/.gitignore")
    $result = Run-Check 0
    if ($result.updated -or [Convert]::ToBase64String($before) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes("$fixture/.gitignore"))) { throw 'Not idempotent' }
    Set-Content "$fixture/.gitignore" "# existing`n.bdd/" -NoNewline
    $null = Run-Check 0
    if (-not ([IO.File]::ReadAllText("$fixture/.gitignore")).StartsWith("# existing`n.bdd/")) { throw 'Existing rules lost' }
    $null = New-Item -ItemType Directory -Path "$fixture/.bdd/modules/nested" -Force
    Set-Content "$fixture/.bdd/modules/nested/.gitignore" '*.feature'
    Set-Content "$fixture/.bdd/modules/nested/case.feature" 'Feature: example'
    Set-Content "$fixture/.gitignore" '# preserved'
    $before = [IO.File]::ReadAllBytes("$fixture/.gitignore")
    $null = Run-Check 2
    if ([Convert]::ToBase64String($before) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes("$fixture/.gitignore"))) { throw 'Conflict did not roll back' }
    Remove-Item -LiteralPath "$fixture/.bdd/modules/nested/.gitignore"
    $null = Run-Check 0
    $null = New-Item -ItemType Directory -Path "$fixture/.bdd/run" -Force
    Set-Content "$fixture/.bdd/run/REPORT.md" 'old output'
    git -C $fixture add -f -- .bdd/run/REPORT.md
    $result = Run-Check 1
    if ($result.trackedOutputs -notcontains '.bdd/run/REPORT.md') { throw 'Tracked output not reported' }
    if (-not (Test-Path "$fixture/.bdd/run/REPORT.md")) { throw 'Tracked output deleted' }
    'PASS check-only, install, idempotence, parent ignore, preservation, nested conflict rollback, tracked outputs'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
