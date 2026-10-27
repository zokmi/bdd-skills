<#
.SYNOPSIS
  為目前的 git worktree 分配一個專屬的 loopback IP（127.0.0.N），讓多個 worktree 同時跑 BDD 時
  各自沿用專案原本的埠號，不需改動任何程式或設定檔。

.DESCRIPTION
  原理：
    - 主目錄預設維持原 localhost；多專案同 port 時明確加 -Isolate 才分配獨立 IP。
    - 每個 worktree 分到 127.0.0.N（N >= 2），後端與前端都綁在這個 IP、但沿用原埠號。
    - 測試用的 Chromium 帶 --host-resolver-rules="MAP localhost 127.0.0.N" 啟動，
      頁面網址與前端寫死的 API 位址（http://localhost:<埠>）都會被導到這個 worktree 的服務；
      瀏覽器送出的 Origin 仍是 http(s)://localhost:<埠>，後端 CORS 白名單不必改。
  分配結果記在 worktree 自己的 git 目錄（<repo>/.git/worktrees/<名稱>/bdd-loopback-slot），
  不進版控、不必改 .gitignore，worktree 移除時會跟著消失，下次分配會清掉失效的共用登記。
  跨 repo 登記與鎖固定放在 %USERPROFILE%/.bdd-loopback/registry-v1，避免 TEMP 隔離造成重複分配。

.PARAMETER Isolate
  主 checkout 明確加入跨 repo 隔離；worktree 預設已隔離。API 與前端 port 均保持原值。

.PARAMETER Ports
  要在分配到的 IP 上檢查占用情況的埠號（例如 9453,4200,4201）。
  綁在 0.0.0.0／:: 的程序會占住所有 IP，也會一併列出。

.OUTPUTS
  JSON：slot、ip、isWorktree、isolated、registryPath、root、chromiumArg、chromeCommand、occupied。

.EXAMPLE
  pwsh -File loopback-slot.ps1 -Ports 9453,4200,4201
#>
param(
    [string[]]$Ports = @(),
    [switch]$Isolate
)

$ErrorActionPreference = 'Stop'

# pwsh -File 會把 "9453,4200" 當成單一字串傳入，這裡統一拆成整數陣列
$portList = @($Ports | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ } | ForEach-Object { [int]$_ })

# 取得 worktree 自身的 git 目錄與共用 git 目錄，兩者相同代表是主目錄
$root = (git rev-parse --show-toplevel).Trim()
$gitDir = (Resolve-Path (git rev-parse --absolute-git-dir).Trim()).Path
$commonDir = (git rev-parse --git-common-dir).Trim()
if (-not [IO.Path]::IsPathRooted($commonDir)) { $commonDir = Join-Path $root $commonDir }
$commonDir = (Resolve-Path $commonDir).Path
$isWorktree = $gitDir -ne $commonDir
$isolated = $isWorktree -or $Isolate

<#
  取得指定 IP 上正在 LISTEN 的連線（含綁 0.0.0.0／:: 而占住所有 IP 的程序）。
  回傳 LocalAddress、LocalPort、OwningProcess 的集合。
#>
function Get-ListenersOnIp([string]$ip) {
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @($ip, '0.0.0.0', '::') }
}

if (-not $isolated) {
    $slot = 1
} else {
    # Cross-repo reservations must exist before listeners start. Keep the lock file
    # permanently; pruning a lease requires its Git directory/slot file to disappear.
    # TEMP/LOCALAPPDATA can differ across sandbox processes on the same machine.
    # The user-profile path stays stable across chats, repos and elevation.
    $registryDir = if ($env:BDD_LOOPBACK_REGISTRY_DIR) { $env:BDD_LOOPBACK_REGISTRY_DIR } else { Join-Path $env:USERPROFILE '.bdd-loopback/registry-v1' }
    $registryDir = [IO.Path]::GetFullPath($registryDir)
    $null = New-Item -ItemType Directory -Path $registryDir -Force
    $globalLock = $null
    $globalDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $globalLock) {
        try {
            $globalLock = [IO.File]::Open((Join-Path $registryDir 'allocation.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $globalDeadline) { throw '取得跨 repo slot 分配鎖逾時，未變更 slot' }
            Start-Sleep -Milliseconds 100
        }
    }
    try {
    $registryFile = Join-Path $registryDir 'reservations.json'
    $leases = @()
    if (Test-Path $registryFile) {
        $registry = Get-Content $registryFile -Raw | ConvertFrom-Json
        if ($registry.version -ne 1) { throw '不支援的 slot registry 版本' }
        foreach ($lease in @($registry.leases)) {
            if (-not $lease.gitDir -or -not [IO.Path]::IsPathRooted($lease.gitDir) -or $lease.slot -lt 2 -or $lease.slot -gt 254) { throw '無效的跨 repo slot 登記，停止分配' }
            if (Test-Path (Join-Path $lease.gitDir 'bdd-loopback-slot')) { $leases += $lease }
        }
        if (@($leases | Group-Object slot | Where-Object Count -gt 1).Count) { throw '跨 repo slot 登記重複，停止分配' }
    }
    # 所有 worktree 共用同一個檔案鎖；鎖檔保留，避免刪除再建立的競態。
    $lockPath = Join-Path $commonDir 'bdd-loopback-allocation.lock'
    $lock = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $lock) {
        try {
            $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw '取得 worktree slot 分配鎖逾時，未變更 slot' }
            Start-Sleep -Milliseconds 100
        }
    }
    try {
    $slotFile = Join-Path $gitDir 'bdd-loopback-slot'
    if (Test-Path $slotFile) {
        $slot = [int](Get-Content $slotFile -Raw).Trim()
    } else {
        # 收集其他 worktree 已登記的 slot，取第一個未登記且該 IP 上沒有專屬監聽的
        $used = @($leases.slot) + @(Get-ChildItem (Join-Path $commonDir 'worktrees') -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'bdd-loopback-slot' } |
            Where-Object { Test-Path $_ } |
            ForEach-Object { [int](Get-Content $_ -Raw).Trim() })
        $slot = $null
        foreach ($n in 2..254) {
            if ($used -contains $n) { continue }
            $busy = Get-NetTCPConnection -State Listen -LocalAddress "127.0.0.$n" -ErrorAction SilentlyContinue
            if ($busy) { continue }
            $slot = $n; break
        }
        if (-not $slot) { throw '127.0.0.2 ~ 127.0.0.254 都已被分配，請清理不用的 worktree' }
        Set-Content -Path $slotFile -Value $slot -NoNewline
    }
    if ($slot -lt 2 -or $slot -gt 254) { throw "無效的 worktree slot：$slot" }
    $duplicates = @(Get-ChildItem (Join-Path $commonDir 'worktrees') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'bdd-loopback-slot' } |
        Where-Object { $_ -ne $slotFile -and (Test-Path $_) } |
        Where-Object { [int](Get-Content $_ -Raw).Trim() -eq $slot })
    if ($duplicates.Count) { throw "worktree slot $slot 重複，停止測試並確認既有服務歸屬；不自動重新分配" }
    $ownLease = @($leases | Where-Object gitDir -eq $gitDir)
    if ($ownLease.Count -gt 1 -or ($ownLease.Count -eq 1 -and $ownLease[0].slot -ne $slot)) { throw '既有 slot 與跨 repo 登記不一致，未重新分配' }
    if (@($leases | Where-Object { $_.slot -eq $slot -and $_.gitDir -ne $gitDir }).Count) { throw "跨 repo slot $slot 已由其他工作區預約，停止並確認既有服務歸屬" }
    if (-not $ownLease.Count) { $leases += [pscustomobject]@{ gitDir = $gitDir; slot = $slot } }
    $registryTemp = Join-Path $registryDir ('reservations-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($registryTemp, (@{ version = 1; leases = @($leases) } | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($registryTemp, $registryFile, $true)
    } finally { if (Test-Path $registryTemp) { Remove-Item -LiteralPath $registryTemp -Force } }
    } finally {
        $lock.Dispose()
    }
    } finally { $globalLock.Dispose() }
}

$ip = "127.0.0.$slot"

# 檢查指定埠號在此 IP 上是否已被占用（可能是本 worktree 已在跑的服務，也可能是綁全部 IP 的程序）
$occupied = @()
if ($portList.Count -gt 0) {
    $listeners = Get-ListenersOnIp $ip
    foreach ($p in $portList) {
        foreach ($l in @($listeners | Where-Object { $_.LocalPort -eq $p })) {
            $proc = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
            $occupied += [pscustomobject]@{
                port    = $p
                address = $l.LocalAddress
                pid     = $l.OwningProcess
                process = if ($proc) { $proc.ProcessName } else { $null }
            }
        }
    }
}

# 主目錄不做對應：平常的服務可能只綁 ::1（如 ng serve），強制導向 IPv4 反而連不到
$chromiumArg = if ($isolated) { "--host-resolver-rules=MAP localhost $ip" } else { '' }
$profileDir = Join-Path $env:TEMP "bdd-chrome-slot$slot"

[pscustomobject]@{
    slot          = $slot
    ip            = $ip
    isWorktree    = $isWorktree
    isolated      = [bool]$isolated
    registryPath  = if ($isolated) { $registryFile } else { $null }
    root          = $root
    chromiumArg   = $chromiumArg
    # 給人工目視用：另開獨立設定檔的 Chrome，不影響平常使用的瀏覽器
    chromeCommand = if ($isolated) { "chrome.exe --user-data-dir=`"$profileDir`" `"$chromiumArg`"" } else { '' }
    occupied      = $occupied
} | ConvertTo-Json -Depth 4
