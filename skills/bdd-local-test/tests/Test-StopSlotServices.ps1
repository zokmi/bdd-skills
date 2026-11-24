# Exercise both the compatibility entry point and the ESM cleanup on one disposable listener.
$ErrorActionPreference = 'Stop'
$stop = Join-Path $PSScriptRoot '../scripts/stop-slot-services.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-stop-' + [guid]::NewGuid())
$repo = Join-Path $fixture 'test checkout'
$null = New-Item -ItemType Directory -Path $repo
$listener = $null
Push-Location -LiteralPath $repo
try {
    git init -q
    if ($LASTEXITCODE -ne 0) { throw 'Fixture git init failed.' }
    $result = & $stop -Ports 12345 | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $result.isWorktree -or $result.stopped.Count) { throw 'Main checkout must preserve ordinary services.' }
    Set-Content -LiteralPath '.git/bdd-loopback-slot' -Value '1'
    $rejected = $false
    try { $null = & $stop -Isolate -DryRun } catch { $rejected = $true }
    if (-not $rejected) { throw 'Isolated cleanup must reject slot 1.' }

    Set-Content -LiteralPath '.git/bdd-loopback-slot' -Value '244'
    $script = Join-Path $repo 'fixture.mjs'
    Set-Content -LiteralPath $script -Value "import { createServer } from 'node:net'; const server = createServer(); server.listen(0,'127.0.0.244', () => console.log(server.address().port));"
    $stdout = Join-Path $fixture 'port.txt'
    $listener = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"' + $script + '"') -WindowStyle Hidden -WorkingDirectory $repo -RedirectStandardOutput $stdout -RedirectStandardError (Join-Path $fixture 'stderr.txt') -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 100
        if ($listener.HasExited) { throw 'Fixture listener exited before binding.' }
        $port = Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue
    } until ($port -or [DateTime]::UtcNow -ge $deadline)
    if (-not $port) { throw 'Timed out waiting for fixture listener.' }

    $preview = & $stop -Ports $port -Isolate -DryRun | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $preview.stopped.Count -ne 1 -or $preview.stopped[0].killedRootPid -ne $listener.Id -or $preview.browsers.Count -or $listener.HasExited) {
        throw 'DryRun must select exactly the fixture listener.'
    }
    $result = & $stop -Ports $port -Isolate | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $result.remaining.Count -or $result.remainingPids.Count -or -not $listener.WaitForExit(5000)) { throw 'The owned listener did not exit.' }
    'PASS main checkout protection, slot validation, dry run, and verified fixture cleanup'
} finally {
    Pop-Location
    if ($null -ne $listener) {
        if (-not $listener.HasExited) { $listener.Kill(); $null = $listener.WaitForExit(5000) }
        $listener.Dispose()
    }
    $resolved = (Resolve-Path -LiteralPath $fixture).Path
    if ((Split-Path $resolved -Parent) -eq [IO.Path]::GetTempPath().TrimEnd('\','/') -and (Split-Path $resolved -Leaf) -match '^bdd-stop-[0-9a-f-]{36}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
