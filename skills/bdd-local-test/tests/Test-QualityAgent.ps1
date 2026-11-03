param([ValidateSet('baseline','candidate')][string]$Version, [switch]$InjectFailure, [ValidateSet('Fixed','Autonomous')][string]$Strategy = 'Autonomous')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../../..").Path
$bench = Join-Path $PSScriptRoot 'Test-QualityBenchmark.cjs'
$fixture = Join-Path ([IO.Path]::GetTempPath()) "bdd-agent-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $projectSettings = Join-Path $fixture '.claude'
    New-Item -ItemType Directory -Path $projectSettings | Out-Null
    $skill = Join-Path $fixture 'SKILL.md'
    if ($Version -eq 'baseline') {
        git -C $repo show '7ff5d82:skills/bdd-local-test/SKILL.md' | Set-Content $skill
        if ($LASTEXITCODE) { throw 'Cannot load baseline Skill' }
        $mode = 'separate'
    } else {
        Copy-Item -LiteralPath (Join-Path $repo 'skills/bdd-local-test/SKILL.md') -Destination $skill
        $mode = 'batch'
    }
    $faultArg = if ($InjectFailure) { ' wrong-state' } else { '' }
    $faultInstruction = if ($InjectFailure) { 'Run the command exactly once. A nonzero exit is final evidence. Never retry or repair the fixture.' }
    $hookPath = Join-Path $fixture 'hook.cjs'
    $skillContext = if ($Version -eq 'candidate') {
        "Apply this preloaded Skill entry:`n$(Get-Content -Raw -LiteralPath $skill)`n"
    } else {
        "Read the Skill at $skill."
    }
    $selection = if ($Strategy -eq 'Fixed') { "Use the fixed strategy $mode." } else {
        'Choose separate unless the Skill explicitly calls for batching compatible operations while retaining individual assertions, in which case choose batch.'
    }
    $context = @{
        hookSpecificOutput = @{
            hookEventName = 'UserPromptSubmit'
            additionalContext = "BDD completion hook $Version. $skillContext The isolated synthetic fixture database is authorized. $selection Execute the single command node `"$bench`" <chosen mode>$faultArg with no suffix, pipes or other commands. Do not inspect the benchmark script. Return only its measured JSON result. $faultInstruction"
        }
    } | ConvertTo-Json -Depth 5 -Compress
    "process.stdin.resume(); process.stdin.on('end', () => console.log($($context | ConvertTo-Json -Compress)));" | Set-Content $hookPath
    $settings = Join-Path $projectSettings 'settings.json'
    @{ hooks = @{ UserPromptSubmit = @(@{ hooks = @(@{ type = 'command'; command = "node `"$hookPath`"" }) }) } } |
        ConvertTo-Json -Depth 8 | Set-Content $settings
    Push-Location -LiteralPath $fixture
    try {
    $events = @('The isolated BDD task is complete. Follow the fixture instructions injected by the hook and report its result.' |
        claude -p --verbose --output-format stream-json --no-session-persistence --setting-sources project --strict-mcp-config --allowedTools Read 'Bash(node *)' 'PowerShell(node *)' --add-dir $fixture | ForEach-Object { $_ | ConvertFrom-Json -ErrorAction Stop })
    if ($LASTEXITCODE) { throw "Claude exited $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    $result = $events | Where-Object type -eq result | Select-Object -Last 1
    $evidence = @(foreach ($event in $events) {
        foreach ($item in $event.message.content) {
            if ($item.type -ne 'tool_result' -or $item.content -isnot [string]) { continue }
            foreach ($line in ($item.content -split "\r?\n")) {
                if ($line.StartsWith('{"mode":')) { $line | ConvertFrom-Json }
            }
        }
    })
    $expected = if ($InjectFailure) { 'FAILED' } else { 'PASSED' }
    if (-not $result -or $result.is_error -or $result.permission_denials.Count -or
        $evidence.Count -ne 1 -or (($Strategy -eq 'Fixed' -or $Version -eq 'candidate') -and $evidence[0].mode -ne $mode) -or $evidence[0].status -ne $expected) {
        throw (@{ evidence = $evidence; result = $result } | ConvertTo-Json -Depth 9 -Compress)
    }
    @{ version = $Version; strategy = $Strategy; fixture = $evidence[0]; agentMs = $result.duration_ms; usage = $result.usage } |
        ConvertTo-Json -Depth 9 -Compress
} finally {
    $resolved = (Resolve-Path -LiteralPath $fixture).Path
    $tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ((Split-Path -Parent $resolved) -ne $tempRoot -or
        (Split-Path -Leaf $resolved) -notmatch '^bdd-agent-[0-9a-f-]{36}$') {
        throw "Unexpected fixture cleanup target: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
