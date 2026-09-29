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
  JSON：isWorktree、ip、stopped（已結束）、skipped（監聽中但不符條件而略過）、remaining（結束後仍在監聽的埠）。

.EXAMPLE
  pwsh -File stop-slot-services.ps1 -Ports 9453,4200,4201 -DryRun
#>
param(
    [string[]]$Ports = @(),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 輸出含中文，統一 UTF-8 讓 Git Bash 等呼叫端讀得正確
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$portList = @($Ports | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ } | ForEach-Object { [int]$_ })

$root = (git rev-parse --show-toplevel).Trim()
$gitDir = (Resolve-Path (git rev-parse --absolute-git-dir).Trim()).Path
$commonDir = (git rev-parse --git-common-dir).Trim()
if (-not [IO.Path]::IsPathRooted($commonDir)) { $commonDir = Join-Path $root $commonDir }
$commonDir = (Resolve-Path $commonDir).Path
$isWorktree = $gitDir -ne $commonDir

if (-not $isWorktree) {
    [pscustomobject]@{ isWorktree = $false; ip = '127.0.0.1'; stopped = @(); skipped = @(); remaining = @()
        message = '主目錄不是 worktree，不停止任何服務' } | ConvertTo-Json -Depth 4
    return
}

$slotFile = Join-Path $gitDir 'bdd-loopback-slot'
if (-not (Test-Path $slotFile)) { throw '本 worktree 尚未分配 slot（找不到 bdd-loopback-slot），沒有可停止的服務' }
$ip = "127.0.0.$([int](Get-Content $slotFile -Raw).Trim())"

# 路徑比對統一成反斜線、小寫，並以結尾分隔符避免 foo 誤中 foo-bar
$rootKey = ((Resolve-Path $root).Path -replace '/', '\').TrimEnd('\').ToLowerInvariant() + '\'

<#
  判斷程序的執行檔路徑或命令列是否位於本 worktree 底下。
#>
function Test-InWorktree($cim) {
    if (-not $cim) { return $false }
    $text = (("$($cim.ExecutablePath) $($cim.CommandLine)") -replace '/', '\').ToLowerInvariant()
    return $text.Contains($rootKey)
}

<#
  從監聽程序往上找：父程序若是 dotnet／node 且同樣位於本 worktree，就改以它為結束對象，
  回傳最上層符合條件的程序 CIM 物件。
#>
function Get-TopOwnedProcess($cim) {
    $top = $cim
    while ($true) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($top.ParentProcessId)" -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        if ($parent.Name -notmatch '^(dotnet|node)(\.exe)?$') { break }
        if (-not (Test-InWorktree $parent)) { break }
        $top = $parent
    }
    return $top
}

$stopped = @()
$skipped = @()
$targets = @{}

foreach ($p in $portList) {
    foreach ($l in @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)) {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -ErrorAction SilentlyContinue
        $name = if ($cim) { $cim.Name } else { $null }
        if ($l.LocalAddress -ne $ip) {
            # 別的 IP（含主目錄的 127.0.0.1、綁全部 IP 的 0.0.0.0／::）一律不動
            if ($l.LocalAddress -in @('0.0.0.0', '::')) {
                $skipped += [pscustomobject]@{ port = $p; address = $l.LocalAddress; pid = $l.OwningProcess; process = $name; reason = '綁全部 IP，非本 worktree 專屬' }
            }
            continue
        }
        if (-not (Test-InWorktree $cim)) {
            $skipped += [pscustomobject]@{ port = $p; address = $l.LocalAddress; pid = $l.OwningProcess; process = $name; reason = '執行檔與命令列都不在本 worktree 底下' }
            continue
        }
        $top = Get-TopOwnedProcess $cim
        $targets[[int]$top.ProcessId] = $top
        $stopped += [pscustomobject]@{ port = $p; address = $l.LocalAddress; pid = $l.OwningProcess; process = $name; killedRootPid = [int]$top.ProcessId; killedRoot = $top.Name }
    }
}

if (-not $DryRun) {
    foreach ($id in $targets.Keys) {
        # /T 連同子程序一起結束；程序可能已隨父程序結束，失敗不中斷
        taskkill /PID $id /T /F 2>&1 | Out-Null
    }
    if ($targets.Count -gt 0) { Start-Sleep -Seconds 2 }
}

$remaining = @()
foreach ($p in $portList) {
    if (Get-NetTCPConnection -State Listen -LocalAddress $ip -LocalPort $p -ErrorAction SilentlyContinue) { $remaining += $p }
}

[pscustomobject]@{
    isWorktree = $true
    ip         = $ip
    dryRun     = [bool]$DryRun
    stopped    = $stopped
    skipped    = $skipped
    remaining  = $remaining
} | ConvertTo-Json -Depth 4
