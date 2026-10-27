param(
    [Parameter(Mandatory)][string]$McpCli,
    [Parameter(Mandatory)][string]$ChromePath,
    [Parameter(Mandatory)][string]$OutputDir,
    [switch]$UseDefaultRegistry
)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('bdd-loopback-live-' + [guid]::NewGuid())
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
$previousRegistry = $env:BDD_LOOPBACK_REGISTRY_DIR
$env:BDD_LOOPBACK_REGISTRY_DIR = if ($UseDefaultRegistry) { $null } else { Join-Path $fixture 'registry' }
$null = New-Item -ItemType Directory -Path $fixture,$OutputDir -Force
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
function Invoke-GitChecked([string[]]$Arguments) {
    & git @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git failed: $Arguments" }
}
try {
    $targets = @()
    foreach ($repo in 'project-a','project-b') {
        $main = Join-Path $fixture $repo
        Invoke-GitChecked @('init','--quiet',$main)
        Invoke-GitChecked @('-C',$main,'-c','user.name=BDD','-c','user.email=bdd@example.invalid','commit','--allow-empty','-m','fixture','--quiet')
        $targets += [pscustomobject]@{ id = "$repo-main"; path = $main; isolate = $true }
        foreach ($name in 'one','two') {
            $target = Join-Path $fixture "$repo-$name"
            Invoke-GitChecked @('-C',$main,'worktree','add','--quiet','--detach',$target)
            $targets += [pscustomobject]@{ id = "$repo-$name"; path = $target; isolate = $false }
        }
    }
    $services = foreach ($target in $targets) {
        Push-Location $target.path
        try {
            $prepared = & "$scripts/prepare-worktree-mcp.ps1" -Ports 4200,9453 -Isolate:$target.isolate -OutputDir (Join-Path $OutputDir $target.id) | ConvertFrom-Json
            $config = Get-Content $prepared.configPath -Raw | ConvertFrom-Json
            $config.browser.launchOptions | Add-Member channel 'chrome'
            $config.browser.launchOptions | Add-Member executablePath $ChromePath
            $config.browser.launchOptions | Add-Member headless $true
            $config | ConvertTo-Json -Depth 8 | Set-Content $prepared.configPath -Encoding utf8
            [pscustomobject]@{ id = $target.id; root = $target.path; ip = $prepared.preflight.ip; uiPort = 4200; apiPort = 9453; configPath = $prepared.configPath; isolationId = $prepared.isolationId; registryPath = $prepared.preflight.registryPath }
        } finally { Pop-Location }
    }
    if (@($services.ip | Sort-Object -Unique).Count -ne 6) { throw 'Six service instances must have distinct IPs' }
    $manifest = Join-Path $OutputDir 'manifest.json'
    @{ services = @($services); mcpCli = [IO.Path]::GetFullPath($McpCli); outputDir = $OutputDir } | ConvertTo-Json -Depth 6 | Set-Content $manifest -Encoding utf8
    & node (Join-Path $PSScriptRoot 'loopback-live.cjs') $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Live Chrome/MCP verification failed' }
} finally {
    $env:BDD_LOOPBACK_REGISTRY_DIR = $previousRegistry
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) -and (Test-Path $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
