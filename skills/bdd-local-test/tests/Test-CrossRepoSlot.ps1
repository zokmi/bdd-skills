$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-cross-repo-' + [guid]::NewGuid())
$allocator = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/loopback-slot.ps1'))
$previousRegistry = $env:BDD_LOOPBACK_REGISTRY_DIR
$env:BDD_LOOPBACK_REGISTRY_DIR = Join-Path $fixture 'registry'
$jobs = @()
function Invoke-GitChecked([string[]]$Arguments) {
    & git @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git failed: $Arguments" }
}
try {
    $null = New-Item -ItemType Directory -Path $fixture
    $targets = @()
    foreach ($repo in 'project-a','project-b') {
        $main = Join-Path $fixture $repo
        Invoke-GitChecked @('init','--quiet',$main)
        Invoke-GitChecked @('-C',$main,'-c','user.name=BDD','-c','user.email=bdd@example.invalid','commit','--allow-empty','-m','fixture','--quiet')
        foreach ($name in 'one','two') {
            $target = Join-Path $fixture "$repo-$name"
            Invoke-GitChecked @('-C',$main,'worktree','add','--quiet','--detach',$target)
            $targets += $target
        }
    }
    # Reserve before any service listens: listener checks alone cannot prevent this collision.
    $results = foreach ($target in $targets) {
        Push-Location $target
        try { & $allocator -Ports 4200,9453 | ConvertFrom-Json } finally { Pop-Location }
    }
    if (@($results.ip | Sort-Object -Unique).Count -ne 4) {
        throw "Cross-repo IP collision before services start: $($results.ip -join ', ')"
    }
    'PASS two repos / four real worktrees reserve unique IPs before listening'
    foreach ($target in $targets) {
        $jobs += Start-Job -ArgumentList $allocator,$target -ScriptBlock {
            param($allocator,$target)
            Set-Location $target
            & $allocator -Ports 4200,9453 | ConvertFrom-Json
        }
    }
    $null = $jobs | Wait-Job -Timeout 45
    if (@($jobs | Where-Object State -ne Completed).Count) { throw 'Allocation jobs failed or timed out' }
    $parallel = @($jobs | Receive-Job -ErrorAction Stop)
    if (@($parallel.ip | Sort-Object -Unique).Count -ne 4) { throw 'Concurrent allocation collided' }
    foreach ($item in $results) {
        if (($parallel | Where-Object root -eq $item.root).ip -ne $item.ip) { throw 'Reservation changed on reuse' }
    }
    'PASS concurrent cross-repo reuse preserves all IPs and original ports'
    $freshTargets = @()
    foreach ($repo in 'project-a','project-b') {
        foreach ($name in 'three','four') {
            $target = Join-Path $fixture "$repo-$name"
            Invoke-GitChecked @('-C',(Join-Path $fixture $repo),'worktree','add','--quiet','--detach',$target)
            $freshTargets += $target
        }
    }
    $jobs | Remove-Job -Force
    $jobs = @()
    foreach ($target in $freshTargets) {
        $jobs += Start-Job -ArgumentList $allocator,$target,$fixture -ScriptBlock {
            param($allocator,$target,$fixture)
            Set-Location $target
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while (-not (Test-Path (Join-Path $fixture 'start'))) {
                if ([DateTime]::UtcNow -gt $deadline) { throw 'Start barrier timed out' }
                Start-Sleep -Milliseconds 50
            }
            & $allocator -Ports 4200,9453 | ConvertFrom-Json
        }
    }
    Set-Content (Join-Path $fixture 'start') 'ready'
    $null = $jobs | Wait-Job -Timeout 45
    if (@($jobs | Where-Object State -ne Completed).Count) { throw 'Fresh allocation jobs failed or timed out' }
    $fresh = @($jobs | Receive-Job -ErrorAction Stop)
    if (@((@($results.ip) + @($fresh.ip)) | Sort-Object -Unique).Count -ne 8) { throw 'Fresh cross-repo allocation collided' }
    'PASS four simultaneous first-time allocations across two repos avoid all existing reservations'
    # An old/unregistered checkout must not silently steal a reserved IP.
    $main = Join-Path $fixture 'project-b'
    $slotPath = Join-Path $main '.git/bdd-loopback-slot'
    Set-Content $slotPath $results[0].slot
    Push-Location $main
    try {
        $rejected = $false
        try { & $allocator -Ports 4200,9453 -Isolate | Out-Null } catch {
            if ($_.Exception.Message -notlike '*已由其他工作區預約*') { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw 'Legacy conflicting slot must be rejected' }
    } finally { Pop-Location }
    'PASS legacy cross-repo conflict is rejected without changing its port/IP'
} finally {
    if ($jobs) { $jobs | Stop-Job; $jobs | Remove-Job -Force }
    $env:BDD_LOOPBACK_REGISTRY_DIR = $previousRegistry
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -and (Test-Path $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
