<#
.SYNOPSIS
產生本輪臨時 Playwright MCP 設定，不啟動服務、不修改專案或全域 MCP 設定。
#>
param(
    [Parameter(Mandatory)][string[]]$Ports,
    [Parameter(Mandatory)][string]$OutputDir,
    [switch]$Isolate,
    [switch]$KeepOriginalPorts,
    [ValidateNotNullOrEmpty()][string]$StorageState,
    [ValidateNotNullOrEmpty()][string]$McpCli
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('prepare-worktree-mcp', "--output-dir=$OutputDir")
foreach ($port in $Ports) { $cliArgs += "--ports=$port" }
if ($Isolate) { $cliArgs += '--isolate' }
if ($KeepOriginalPorts) { $cliArgs += '--keep-original-ports' }
if ($PSBoundParameters.ContainsKey('StorageState')) { $cliArgs += "--storage-state=$StorageState" }
if ($PSBoundParameters.ContainsKey('McpCli')) { $cliArgs += "--mcp-cli=$McpCli" }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
