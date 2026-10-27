$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-mcp-' + [guid]::NewGuid())
$previousRegistry = $env:BDD_LOOPBACK_REGISTRY_DIR
$env:BDD_LOOPBACK_REGISTRY_DIR = Join-Path $fixture 'registry'
$null = New-Item -ItemType Directory -Path "$fixture/repo", "$fixture/common/worktrees/a", "$fixture/common/worktrees/b"
$scripts = Join-Path $PSScriptRoot '../scripts'
function git {
    if ($args -contains '--show-toplevel') { return "$fixture/repo" }
    if ($args -contains '--absolute-git-dir') { return "$fixture/common/worktrees/a" }
    if ($args -contains '--git-common-dir') { return "$fixture/common" }
    throw 'Unexpected git invocation'
}
function Get-NetTCPConnection { param($State, $LocalAddress, $ErrorAction) @() }
try {
    $jobs = @()
    foreach ($index in 1..4) {
        $null = New-Item -ItemType Directory -Path "$fixture/common/worktrees/parallel-$index"
        $jobs += Start-Job -ArgumentList $fixture,$scripts,$index -ScriptBlock {
            param($fixture,$scripts,$index)
            $ErrorActionPreference = 'Stop'
            function git {
                if ($args -contains '--show-toplevel') { return "$fixture/repo" }
                if ($args -contains '--absolute-git-dir') { return "$fixture/common/worktrees/parallel-$index" }
                if ($args -contains '--git-common-dir') { return "$fixture/common" }
            }
            function Get-NetTCPConnection { param($State, $LocalAddress, $ErrorAction) Start-Sleep -Milliseconds 150; @() }
            Set-Content "$fixture/ready-$index" 'ready'
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while (-not (Test-Path "$fixture/start")) {
                if ([DateTime]::UtcNow -gt $deadline) { throw 'Start barrier timed out' }
                Start-Sleep -Milliseconds 50
            }
            & "$scripts/loopback-slot.ps1" -Ports 4200 | ConvertFrom-Json
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (@(Get-ChildItem "$fixture/ready-*").Count -lt 4) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Workers did not become ready' }
        Start-Sleep -Milliseconds 100
    }
    Set-Content "$fixture/start" 'start'
    $null = $jobs | Wait-Job -Timeout 30
    if (@($jobs | Where-Object State -ne Completed).Count) { throw 'Concurrent allocation did not complete' }
    $allocations = @($jobs | Receive-Job -ErrorAction Stop)
    if (@($allocations.slot | Sort-Object -Unique).Count -ne 4) { throw 'Concurrent workers received duplicate slots' }
    'PASS four concurrent processes receive distinct slots'
    $first = & "$scripts/loopback-slot.ps1" -Ports 4200,5000 | ConvertFrom-Json
    $second = & "$scripts/loopback-slot.ps1" -Ports 4200,5000 | ConvertFrom-Json
    if ($first.slot -ne $second.slot) { throw 'Slot must be stable' }
    $result = & "$scripts/prepare-worktree-mcp.ps1" -Ports 4200,5000 -OutputDir "$fixture/output" | ConvertFrom-Json
    $config = Get-Content $result.configPath -Raw | ConvertFrom-Json
    if ($config.browser.launchOptions.args -notcontains $first.chromiumArg) { throw 'Missing worktree resolver' }
    if (-not $config.browser.isolated) { throw 'Browser must be isolated' }
    if ($result.server.args -notcontains '--config') { throw 'MCP launch must use config' }
    if (@($result.ports) -join ',' -ne '4200,5000') { throw 'Original ports changed' }
    $next = & "$scripts/prepare-worktree-mcp.ps1" -Ports 4200,5000 -OutputDir "$fixture/output2" | ConvertFrom-Json
    if ($next.isolationId -eq $result.isolationId) { throw 'Each MCP instance needs unique identity' }
    $rejected = $false
    try { & "$scripts/prepare-worktree-mcp.ps1" -Ports 0 -OutputDir "$fixture/invalid" | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path "$fixture/invalid")) { throw 'Invalid ports must fail before writing configuration' }
    Set-Content "$fixture/common/worktrees/b/bdd-loopback-slot" $first.slot
    $rejected = $false
    try { & "$scripts/loopback-slot.ps1" -Ports 4200 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Duplicate existing slots must be rejected' }
    Set-Content "$fixture/common/worktrees/b/bdd-loopback-slot" 254
    Set-Content "$fixture/common/worktrees/a/bdd-loopback-slot" 1
    $rejected = $false
    try { & "$scripts/loopback-slot.ps1" -Ports 4200 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid existing slot must be rejected' }
    # 主目錄不可強制導向 IPv4：原服務可能只監聽 ::1。
    function git {
        if ($args -contains '--show-toplevel') { return "$fixture/repo" }
        if ($args -contains '--absolute-git-dir') { return "$fixture/common" }
        if ($args -contains '--git-common-dir') { return "$fixture/common" }
    }
    $main = & "$scripts/prepare-worktree-mcp.ps1" -Ports 4200 -OutputDir "$fixture/main-output" | ConvertFrom-Json
    $mainConfig = Get-Content $main.configPath -Raw | ConvertFrom-Json
    if (@($mainConfig.browser.launchOptions.args).Count -ne 0) { throw 'Main checkout must retain original localhost resolution' }
    'PASS stable slot, MCP isolation/config, unchanged ports, unique identity, duplicate rejection'
    'PASS invalid port/slot rejection and unchanged main-checkout resolution'
} finally {
    $env:BDD_LOOPBACK_REGISTRY_DIR = $previousRegistry
    if ($jobs) { $jobs | Stop-Job; $jobs | Remove-Job -Force }
    if ([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
