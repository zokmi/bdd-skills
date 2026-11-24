<#
.SYNOPSIS
  為目前的 git worktree 分配一個專屬的 loopback IP（127.0.0.N），讓多個 worktree 同時跑 BDD 時
  優先使用專案原埠，被占用時為本輪選擇可綁定的臨時埠。

.DESCRIPTION
  原理：
    - 主目錄預設維持原 localhost；多專案同 port 時明確加 -Isolate 才分配獨立 IP。
    - 每個 worktree 分到 127.0.0.N（N >= 2），服務綁在這個 IP 及本輪 effectivePort。
    - 測試用的 Chromium 帶 --host-resolver-rules="MAP localhost 127.0.0.N" 啟動，
      讓瀏覽器使用 localhost 連到這個 worktree 的 IP，連線埠由實際請求網址決定。
  分配結果記在 worktree 自己的 git 目錄（<repo>/.git/worktrees/<名稱>/bdd-loopback-slot），
  不進版控、不必改 .gitignore，worktree 移除時會跟著消失，下次分配會清掉失效的共用登記。
  跨 repo 登記與鎖固定放在 %USERPROFILE%/.bdd-loopback/registry-v1，避免 TEMP 隔離造成重複分配。

.PARAMETER Isolate
  主 checkout 明確加入跨 repo 隔離；worktree 預設已隔離。

.PARAMETER KeepOriginalPorts
  保留原埠，仍回報占用。適用明確要求固定埠或已確認要沿用原埠服務的輪次。

.PARAMETER Ports
  要在分配到的 IP 上檢查占用情況的埠號（例如 9453,4200,4201）。
  綁在 0.0.0.0／:: 的程序會占住所有 IP，也會一併列出。

.OUTPUTS
  JSON：slot、ip、isWorktree、isolated、registryPath、root、chromiumArg、chromeCommand、occupied、portMappings。

.EXAMPLE
  pwsh -File loopback-slot.ps1 -Ports 9453,4200,4201
#>
param(
    [string[]]$Ports = @(),
    [switch]$Isolate,
    [switch]$KeepOriginalPorts
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('loopback-slot')
foreach ($port in $Ports) { $cliArgs += "--ports=$port" }
if ($Isolate) { $cliArgs += '--isolate' }
if ($KeepOriginalPorts) { $cliArgs += '--keep-original-ports' }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
$output
