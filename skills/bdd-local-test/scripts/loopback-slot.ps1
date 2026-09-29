<#
.SYNOPSIS
  為目前的 git worktree 分配一個專屬的 loopback IP（127.0.0.N），讓多個 worktree 同時跑 BDD 時
  各自沿用專案原本的埠號，不需改動任何程式或設定檔。

.DESCRIPTION
  原理：
    - 主目錄（非 worktree）固定用 127.0.0.1，也就是平常 localhost 的服務，維持原狀。
    - 每個 worktree 分到 127.0.0.N（N >= 2），後端與前端都綁在這個 IP、但沿用原埠號。
    - 測試用的 Chromium 帶 --host-resolver-rules="MAP localhost 127.0.0.N" 啟動，
      頁面網址與前端寫死的 API 位址（http://localhost:<埠>）都會被導到這個 worktree 的服務；
      瀏覽器送出的 Origin 仍是 http(s)://localhost:<埠>，後端 CORS 白名單不必改。
  分配結果記在 worktree 自己的 git 目錄（<repo>/.git/worktrees/<名稱>/bdd-loopback-slot），
  不進版控、不必改 .gitignore，worktree 移除時會跟著消失，slot 自動釋放。

.PARAMETER Ports
  要在分配到的 IP 上檢查占用情況的埠號（例如 9453,4200,4201）。
  綁在 0.0.0.0／:: 的程序會占住所有 IP，也會一併列出。

.OUTPUTS
  JSON：slot、ip、isWorktree、root、chromiumArg、chromeCommand、occupied。

.EXAMPLE
  pwsh -File loopback-slot.ps1 -Ports 9453,4200,4201
#>
param(
    [string[]]$Ports = @()
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

<#
  取得指定 IP 上正在 LISTEN 的連線（含綁 0.0.0.0／:: 而占住所有 IP 的程序）。
  回傳 LocalAddress、LocalPort、OwningProcess 的集合。
#>
function Get-ListenersOnIp([string]$ip) {
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @($ip, '0.0.0.0', '::') }
}

if (-not $isWorktree) {
    $slot = 1
} else {
    $slotFile = Join-Path $gitDir 'bdd-loopback-slot'
    if (Test-Path $slotFile) {
        $slot = [int](Get-Content $slotFile -Raw).Trim()
    } else {
        # 收集其他 worktree 已登記的 slot，取第一個未登記且該 IP 上沒有專屬監聽的
        $used = @(Get-ChildItem (Join-Path $commonDir 'worktrees') -Directory -ErrorAction SilentlyContinue |
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
$chromiumArg = if ($isWorktree) { "--host-resolver-rules=MAP localhost $ip" } else { '' }
$profileDir = Join-Path $env:TEMP "bdd-chrome-slot$slot"

[pscustomobject]@{
    slot          = $slot
    ip            = $ip
    isWorktree    = $isWorktree
    root          = $root
    chromiumArg   = $chromiumArg
    # 給人工目視用：另開獨立設定檔的 Chrome，不影響平常使用的瀏覽器
    chromeCommand = if ($isWorktree) { "chrome.exe --user-data-dir=`"$profileDir`" `"$chromiumArg`"" } else { '' }
    occupied      = $occupied
} | ConvertTo-Json -Depth 4
