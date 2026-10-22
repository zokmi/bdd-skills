<#
.SYNOPSIS
產生本輪臨時 Playwright MCP 設定，不啟動服務、不修改專案或全域 MCP 設定。
#>
param(
    [Parameter(Mandatory)][string[]]$Ports,
    [Parameter(Mandatory)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
$portList = @($Ports | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ } | ForEach-Object { [int]$_ })
if (-not $portList.Count -or @($portList | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count) {
    throw 'Ports 必須是專案原有埠號（1..65535），不得改埠分流'
}
$preflight = & (Join-Path $PSScriptRoot 'loopback-slot.ps1') -Ports $Ports | ConvertFrom-Json
$output = [IO.Path]::GetFullPath($OutputDir)
$null = New-Item -ItemType Directory -Path $output -Force
$isolationId = 'bdd-mcp-' + [guid]::NewGuid().ToString('N')
$configPath = Join-Path $output "$isolationId.json"
$browserArgs = @()
if ($preflight.isWorktree) { $browserArgs += $preflight.chromiumArg }
$config = @{
    browser = @{
        browserName = 'chromium'
        isolated = $true
        launchOptions = @{ args = $browserArgs }
    }
    outputDir = (Join-Path $output $isolationId)
}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
[pscustomobject]@{
    isolationId = $isolationId
    configPath = $configPath
    ports = $portList
    preflight = $preflight
    server = @{
        command = 'npx'
        args = @('--no-install', '@playwright/mcp', '--config', $configPath)
    }
    status = 'configuration-only'
    verificationRequired = @('獨立 MCP 連線與瀏覽器', '前端及 API 的實際目標 IP、原埠號與受測版本', '帳號及資料範圍隔離')
} | ConvertTo-Json -Depth 8
