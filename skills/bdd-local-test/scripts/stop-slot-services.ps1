<#
.SYNOPSIS
  停止目前 git worktree 在其專屬 loopback IP（127.0.0.N）上啟動的前後端服務。
  BDD 全數通過後由 skill 呼叫，釋放埠號與記憶體。

.DESCRIPTION
  只停「確定屬於本 worktree」的程序，三個條件都要成立：
    1. 目前目錄是 worktree（主目錄一律不動，那是使用者平常在跑的服務）。
    2. 程序監聽在本 worktree 的 slot IP 上，且是精確的 127.0.0.N——綁 0.0.0.0／:: 的程序不算。
    3. 程序的執行檔路徑或命令列含本 worktree 的根目錄路徑。
  符合條件的監聽程序，會往上找同樣含 worktree 路徑的 dotnet／node 祖先（dotnet run、npx 等啟動器），
  從最上層那個連同子程序一起結束，避免啟動器殘留或自動重啟服務。
  slot 分配檔不會刪除，worktree 移除時才釋放。

.PARAMETER Ports
  要停止的埠號（例如 9453,4200,4201）。

.PARAMETER DryRun
  只列出會被停止的程序，不實際結束。

.OUTPUTS
  JSON：isWorktree、ip、stopped（服務選取清單）、browsers（以本 worktree profile 辨識的瀏覽器主程序）、skipped、remaining。
  DryRun 僅列出選取清單；實際執行後仍須核對瀏覽器是否退出。

.EXAMPLE
  pwsh -File stop-slot-services.ps1 -Ports 9453,4200,4201 -DryRun
#>
param(
    [string[]]$Ports = @(),
    [switch]$DryRun,
    [switch]$Isolate
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('stop-slot-services')
foreach ($port in $Ports) { $cliArgs += "--ports=$port" }
if ($DryRun) { $cliArgs += '--dry-run' }
if ($Isolate) { $cliArgs += '--isolate' }
$output = & node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs 2>&1
$code = $LASTEXITCODE
if ($code -ge 2) { throw ($output -join [Environment]::NewLine) }
$output
exit $code
