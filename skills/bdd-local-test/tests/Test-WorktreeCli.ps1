$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-cli-' + [guid]::NewGuid())
$previousRegistry = $env:BDD_LOOPBACK_REGISTRY_DIR
$env:BDD_LOOPBACK_REGISTRY_DIR = Join-Path $fixture 'registry'
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
$repo = Join-Path $fixture 'repo'
$a = Join-Path $fixture 'a'
$pushed = $false
try {
    $null = New-Item -ItemType Directory -Path $repo -Force
    git -C $repo init -q
    git -C $repo -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m base
    foreach ($name in @('a','b','parallel-1','parallel-2','parallel-3','parallel-4')) {
        git -C $repo worktree add --quiet --detach (Join-Path $fixture $name) HEAD
        if ($LASTEXITCODE -ne 0) { throw "Cannot create fixture worktree $name" }
    }
    Push-Location -LiteralPath $a
    $pushed = $true
    $statePath = Join-Path $fixture 'private state.json'
    [IO.File]::WriteAllText($statePath, '{"cookies":[],"origins":[]}')
    $withState = & "$scripts/prepare-worktree-cli.ps1" -Ports 4200 -OutputDir "$fixture/auth-output" -StorageState $statePath | ConvertFrom-Json
    if ($withState.storageState -cne $statePath) {
        throw 'CLI must load the selected storage state'
    }
    $authConfig = Get-Content -LiteralPath $withState.configPath -Raw | ConvertFrom-Json
    if (-not $authConfig.browser.isolated) { throw 'Loading state must preserve browser isolation' }
    $rejected = $false
    try {
        & "$scripts/prepare-worktree-cli.ps1" -Ports 4200 -OutputDir "$fixture/missing-state-output" -StorageState "$fixture/missing.json" | Out-Null
    } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path "$fixture/missing-state-output")) {
        throw 'Missing state must fail before writing configuration'
    }
    'PASS storage state is optional, preserves isolation, and requires an existing file'
    $installedCli = Join-Path $fixture 'installed playwright-cli.js'
    [IO.File]::WriteAllText($installedCli, '// installed CLI fixture')
    $direct = & "$scripts/prepare-worktree-cli.ps1" -Ports 4200 -OutputDir "$fixture/direct-output" -CliPath $installedCli -StorageState $statePath | ConvertFrom-Json
    if ($direct.cliPath -cne $installedCli -or $direct.storageState -cne $statePath) {
        throw 'CLI must carry the selected installed CLI and storage state in the prepared manifest'
    }
    $rejected = $false
    try {
        & "$scripts/prepare-worktree-cli.ps1" -Ports 4200 -OutputDir "$fixture/missing-cli-output" -CliPath "$fixture/missing-cli.js" | Out-Null
    } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path "$fixture/missing-cli-output")) {
        throw 'Missing installed CLI must fail before writing configuration'
    }
    'PASS explicit installed CLI is recorded and a missing file fails before preparation'
    $jobs = @()
    foreach ($index in 1..4) {
        $jobs += Start-Job -ArgumentList $fixture,$scripts,$index -ScriptBlock {
            param($fixture,$scripts,$index)
            $ErrorActionPreference = 'Stop'
            Set-Location -LiteralPath (Join-Path $fixture "parallel-$index")
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
    $result = & "$scripts/prepare-worktree-cli.ps1" -Ports 4200,5000 -OutputDir "$fixture/output" | ConvertFrom-Json
    $config = Get-Content $result.configPath -Raw | ConvertFrom-Json
    if ($config.browser.launchOptions.args -notcontains $first.chromiumArg) { throw 'Missing worktree resolver' }
    if (-not $config.browser.isolated) { throw 'Browser must be isolated' }
    if ($result.isolationId -notmatch '^bdd-cli-[a-f0-9]{32}$') { throw 'Expected named CLI session' }
    if ($result.storageState) { throw 'Fresh runs must start without storage state' }
    if (@($result.ports) -join ',' -ne '4200,5000') { throw 'Original ports changed' }
    $owner = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 0)
    $owner.ExclusiveAddressUse = $true
    $owner.Start()
    try {
        $original = $owner.LocalEndpoint.Port
        $fallback = & "$scripts/prepare-worktree-cli.ps1" -Ports $original -OutputDir "$fixture/fallback" | ConvertFrom-Json
        $mapping = $fallback.portMappings[0]
        if ($mapping.originalPort -ne $original -or $mapping.effectivePort -eq $original -or
            $mapping.effectivePort -lt 1 -or $fallback.effectivePorts[0] -ne $mapping.effectivePort) {
            throw 'Wildcard collision must return an effective port distinct from the original'
        }
        $candidate = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($fallback.preflight.ip), $mapping.effectivePort)
        $candidate.ExclusiveAddressUse = $true
        try {
            $candidate.Start()
            if ($owner.LocalEndpoint.Port -ne $original) { throw 'Original listener was stopped' }
        } finally { $candidate.Stop() }
        $fixed = & "$scripts/loopback-slot.ps1" -Ports $original -KeepOriginalPorts | ConvertFrom-Json
        if ($fixed.portMappings[0].effectivePort -ne $original) {
            throw 'Explicit fixed-port runs must retain the original port'
        }
    } finally {
        $owner.Stop()
    }
    'PASS wildcard conflict yields a bindable temporary port and preserves the original listener'
    $next = & "$scripts/prepare-worktree-cli.ps1" -Ports 4200,5000 -OutputDir "$fixture/output2" | ConvertFrom-Json
    if ($next.isolationId -eq $result.isolationId) { throw 'Each CLI instance needs unique identity' }
    $rejected = $false
    try { & "$scripts/prepare-worktree-cli.ps1" -Ports 0 -OutputDir "$fixture/invalid" | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or (Test-Path "$fixture/invalid")) { throw 'Invalid ports must fail before writing configuration' }
    Set-Content "$repo/.git/worktrees/b/bdd-loopback-slot" $first.slot
    $rejected = $false
    try { & "$scripts/loopback-slot.ps1" -Ports 4200 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Duplicate existing slots must be rejected' }
    Set-Content "$repo/.git/worktrees/b/bdd-loopback-slot" 254
    Set-Content "$repo/.git/worktrees/a/bdd-loopback-slot" 1
    $rejected = $false
    try { & "$scripts/loopback-slot.ps1" -Ports 4200 | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid existing slot must be rejected' }
    # 主目錄不可強制導向 IPv4：原服務可能只監聽 ::1。
    Set-Location -LiteralPath $repo
    $main = & "$scripts/prepare-worktree-cli.ps1" -Ports 4200 -OutputDir "$fixture/main-output" | ConvertFrom-Json
    $mainConfig = Get-Content $main.configPath -Raw | ConvertFrom-Json
    if (@($mainConfig.browser.launchOptions.args).Count -ne 0) { throw 'Main checkout must retain original localhost resolution' }
    'PASS stable slot, CLI isolation/config, unchanged ports, unique identity, duplicate rejection'
    'PASS invalid port/slot rejection and unchanged main-checkout resolution'
} finally {
    if ($pushed) { Pop-Location }
    $env:BDD_LOOPBACK_REGISTRY_DIR = $previousRegistry
    if ($jobs) { $jobs | Stop-Job; $jobs | Remove-Job -Force }
    if ([IO.Path]::GetFullPath($fixture).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))) {
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
