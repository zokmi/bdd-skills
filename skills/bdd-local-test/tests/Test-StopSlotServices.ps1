$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-stop-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path "$fixture/repo", "$fixture/git", "$fixture/common"
Set-Content "$fixture/git/bdd-loopback-slot" '5'
$killed = [Collections.Generic.List[int]]::new()
function git {
    if ($args -contains '--show-toplevel') { return "$fixture/repo" }
    if ($args -contains '--absolute-git-dir') { return "$fixture/git" }
    if ($args -contains '--git-common-dir') { return "$fixture/common" }
    throw 'Unexpected git invocation'
}
function Get-NetTCPConnection { param($State, $LocalPort, $LocalAddress, $ErrorAction) @() }
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($Filter) { return $null }
    @(
        [pscustomobject]@{ ProcessId=101; ParentProcessId=1; Name='chrome.exe'; ExecutablePath='C:/playwright/chrome.exe'; CommandLine="chrome --user-data-dir=`"$fixture/repo/.bdd/run/login-profile`" --remote-debugging-pipe" }
        [pscustomobject]@{ ProcessId=102; ParentProcessId=1; Name='chrome.exe'; ExecutablePath='C:/chrome.exe'; CommandLine="chrome --user-data-dir=`"$fixture/repo-other/profile`"" }
        [pscustomobject]@{ ProcessId=103; ParentProcessId=101; Name='chrome.exe'; ExecutablePath='C:/chrome.exe'; CommandLine="chrome --type=renderer --user-data-dir=`"$fixture/repo/.bdd/run/login-profile`"" }
        [pscustomobject]@{ ProcessId=104; ParentProcessId=1; Name='chrome.exe'; ExecutablePath='C:/chrome.exe'; CommandLine="chrome --user-data-dir=C:/personal --app=$fixture/repo/page" }
    )
}
function taskkill { $killed.Add([int]$args[1]) }
function Start-Sleep { param($Seconds) }
try {
    $stop = Join-Path $PSScriptRoot '../scripts/stop-slot-services.ps1'
    $result = & $stop -Ports 9453,4200,4201 -DryRun | ConvertFrom-Json
    if (@($result.browsers).Count -ne 1 -or $result.browsers[0].pid -ne 101) { throw 'Owned login browser must be selected even without a listening service' }
    if ($killed.Count) { throw 'DryRun killed a process' }
    $result = & $stop -Ports 9453,4200,4201 | ConvertFrom-Json
    if ($killed.Count -ne 1 -or $killed[0] -ne 101) { throw 'Must kill only the owned browser root' }
    'PASS browser ownership, no listener, DryRun and process-tree cleanup'
    function git {
        if ($args -contains '--show-toplevel') { return "$fixture/repo" }
        if ($args -contains '--absolute-git-dir') { return "$fixture/git" }
        if ($args -contains '--git-common-dir') { return "$fixture/git" }
        throw 'Unexpected git invocation'
    }
    $killed.Clear()
    $result = & $stop -Ports 9453 | ConvertFrom-Json
    if ($killed.Count -or $result.isWorktree) { throw 'Default main checkout must not stop anything' }
    $result = & $stop -Ports 9453 -Isolate | ConvertFrom-Json
    if ($result.isWorktree -or -not $result.isolated -or $killed.Count -ne 1) { throw 'Explicit isolated main checkout cleanup failed' }
    Set-Content "$fixture/git/bdd-loopback-slot" '1'
    $rejected = $false
    try { & $stop -Ports 9453 -Isolate | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or $killed.Count -ne 1) { throw 'Isolated cleanup must reject localhost slot 1' }
    'PASS main checkout opt-in cleanup and invalid slot safety'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}

