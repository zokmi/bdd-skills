<#
.SYNOPSIS
  封存測試使用的 PowerShell 輔助函式，處理路徑、worktree、設定與索引。
#>

Set-StrictMode -Version 3.0

# 中文檔名不要被 git 轉成八進位跳脫；git 輸出以 UTF-8 解讀
$env:GIT_CONFIG_COUNT = '1'; $env:GIT_CONFIG_KEY_0 = 'core.quotepath'; $env:GIT_CONFIG_VALUE_0 = 'off'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:IgnoreCase = [StringComparison]::OrdinalIgnoreCase

<#
.SYNOPSIS
  證據裡視為「圖片、需要遮罩檢查」的副檔名。
#>
$script:ImageExtensions = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp')

<#
.SYNOPSIS
  已經是壓縮格式、再壓也不會變小的副檔名；ZIP 內以不壓縮方式存放以節省時間。
#>
$script:PrecompressedExtensions = @('.png', '.jpg', '.jpeg', '.webp', '.gif', '.zip', '.gz', '.7z', '.mp4', '.webm', '.pdf')

<#
.SYNOPSIS
  索引裡允許的封存狀態。
  local-only：只在本機；uploaded：已上傳 issue；uploaded-verified：已上傳並確認可下載；superseded：被同主題的新封存取代。
#>
$script:ArchiveStatuses = @('local-only', 'uploaded', 'uploaded-verified', 'superseded')

<#
.SYNOPSIS
  把路徑轉成完整絕對路徑並去掉結尾分隔符號。相對路徑以 PowerShell 目前位置為基準（不是行程的工作目錄）。
#>
function Get-NormalizedPath([Parameter(Mandatory)][string]$Path) {
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    [IO.Path]::GetFullPath($resolved).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

<#
.SYNOPSIS
  判斷 Child 是否等於 Parent 或位於 Parent 之下（不分大小寫）。
#>
function Test-PathUnder([Parameter(Mandatory)][string]$Child, [Parameter(Mandatory)][string]$Parent) {
    $c = Get-NormalizedPath $Child
    $p = Get-NormalizedPath $Parent
    $c.Equals($p, $script:IgnoreCase) -or $c.StartsWith($p + [IO.Path]::DirectorySeparatorChar, $script:IgnoreCase)
}

<#
.SYNOPSIS
  計算檔案或資料流的 SHA-256，回傳大寫十六進位字串。
#>
function Get-Sha256Hex {
    param([string]$Path, [IO.Stream]$Stream)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        if ($Path) {
            $fs = [IO.File]::OpenRead($Path)
            try { return [Convert]::ToHexString($sha.ComputeHash($fs)) } finally { $fs.Dispose() }
        }
        return [Convert]::ToHexString($sha.ComputeHash($Stream))
    } finally { $sha.Dispose() }
}

<#
.SYNOPSIS
  回傳路徑本身或最近一層實際存在的上層目錄；git -C 遇到不存在的路徑會直接失敗，查詢前先用這個往上找。
#>
function Get-ExistingAncestor([Parameter(Mandatory)][string]$Path) {
    $probe = Get-NormalizedPath $Path
    while ($probe -and -not (Test-Path -LiteralPath $probe)) { $probe = Split-Path $probe -Parent }
    if (-not $probe) { throw "找不到存在的上層目錄：$Path" }
    $probe
}

<#
.SYNOPSIS
  取得某路徑所屬 git repo 的所有 worktree 絕對路徑（第一個是主 checkout）。不在 git 內則回傳空陣列。
#>
function Get-RepoWorktrees([Parameter(Mandatory)][string]$AnyPath) {
    $lines = @(git -C (Get-ExistingAncestor $AnyPath) worktree list --porcelain 2>$null)
    if ($LASTEXITCODE -ne 0) { return @() }
    @($lines | Where-Object { $_ -like 'worktree *' } | ForEach-Object { Get-NormalizedPath $_.Substring(9) })
}

<#
.SYNOPSIS
  從 .bdd 輸出目錄往上找 git 頂層；找不到時丟例外。
#>
function Get-RepoTopLevel([Parameter(Mandatory)][string]$AnyPath) {
    $top = git -C (Get-ExistingAncestor $AnyPath) rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $top) { throw "不在 git 工作區內：$AnyPath" }
    Get-NormalizedPath ($top | Select-Object -First 1).Trim()
}

<#
.SYNOPSIS
  讀取 BDD 設定檔 .bdd/config.json。
  先找輸出目錄上一層（也就是本 worktree 的 .bdd/），沒有再找主 checkout 的 .bdd/。
  回傳 @{ path = 設定檔路徑或 $null; data = 設定內容（PSCustomObject，可能為空物件） }。
#>
function Get-BddConfig([Parameter(Mandatory)][string]$BddDir) {
    $candidates = [Collections.Generic.List[string]]::new()
    $candidates.Add((Join-Path (Split-Path (Get-NormalizedPath $BddDir) -Parent) 'config.json'))
    $worktrees = @(Get-RepoWorktrees $BddDir)
    if ($worktrees.Count) { $candidates.Add((Join-Path $worktrees[0] '.bdd/config.json')) }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) {
            return @{ path = (Get-NormalizedPath $c); data = (Get-Content -LiteralPath $c -Raw -Encoding utf8 | ConvertFrom-Json) }
        }
    }
    @{ path = $null; data = [pscustomobject]@{} }
}

<#
.SYNOPSIS
  安全讀取設定物件的屬性，不存在時回傳預設值。
#>
function Get-ConfigValue($Object, [string]$Name, $Default = $null) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    $Default
}

<#
.SYNOPSIS
  決定本機封存庫的根目錄。
  優先序：參數 -ArchiveRoot → 環境變數 BDD_ARCHIVE_ROOT → .bdd/config.json 的 archiveRoot → 使用者目錄\bdd-archives\<主 checkout 資料夾名>。
  回傳 @{ path = 絕對路徑; source = 來源說明 }。
#>
function Resolve-ArchiveRoot {
    param([Parameter(Mandatory)][string]$BddDir, [string]$ArchiveRoot)
    $source = $null; $value = $null
    if ($ArchiveRoot) { $value = $ArchiveRoot; $source = 'parameter' }
    elseif ($env:BDD_ARCHIVE_ROOT) { $value = $env:BDD_ARCHIVE_ROOT; $source = 'env:BDD_ARCHIVE_ROOT' }
    else {
        $config = Get-BddConfig $BddDir
        $configured = Get-ConfigValue $config.data 'archiveRoot'
        if ($configured) { $value = $configured; $source = "config:$($config.path)" }
    }
    if ($value) {
        if ($value.StartsWith('~')) { $value = [Environment]::GetFolderPath('UserProfile') + $value.Substring(1) }
        if (-not [IO.Path]::IsPathFullyQualified($value)) { throw "封存位置必須是絕對路徑（來源 $source）：$value" }
        return @{ path = (Get-NormalizedPath $value); source = $source }
    }
    $worktrees = @(Get-RepoWorktrees $BddDir)
    $repoName = if ($worktrees.Count) { Split-Path $worktrees[0] -Leaf } else { 'unknown-repo' }
    @{ path = (Get-NormalizedPath (Join-Path ([Environment]::GetFolderPath('UserProfile')) "bdd-archives/$repoName")); source = 'default' }
}

<#
.SYNOPSIS
  讀取封存索引 index.jsonl 的所有事件（每行一個 JSON）。檔案不存在時回傳空陣列。
#>
function Read-ArchiveIndex([Parameter(Mandatory)][string]$Root) {
    $file = Join-Path $Root 'index.jsonl'
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    @(Get-Content -LiteralPath $file -Encoding utf8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}

<#
.SYNOPSIS
  在封存索引追加一筆事件。索引只增不改，目前狀態以每個封存檔的最後一筆 status 事件為準。
#>
function Add-ArchiveIndexEvent([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)]$Event) {
    $OutputEncoding = $script:Utf8NoBom
    $PSNativeCommandUseErrorActionPreference = $false
    $line = $Event | ConvertTo-Json -Depth 6 -Compress
    $output = $line | & node (Join-Path $PSScriptRoot 'archive-index.mjs') (Get-NormalizedPath $Root) 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
}

<#
.SYNOPSIS
  彙整索引事件，回傳每個封存檔目前的狀態清單。
  每筆含 archive、name、issue、topic、commit、sha256、bytes、repo、createdAt、status、attachments、statusAt、legacy（舊版匯入、沒有 manifest）、recompressed（是否重新壓縮過）、
  issueCopySha256（issue 附件那一版的 SHA-256，未重新壓縮為 null）。
#>
function Get-ArchiveStates([Parameter(Mandatory)][string]$Root) {
    $states = [ordered]@{}
    foreach ($e in Read-ArchiveIndex $Root) {
        $key = (Get-NormalizedPath $e.archive).ToLowerInvariant()
        if ($e.event -eq 'created') {
            $states[$key] = [ordered]@{
                archive = $e.archive; name = $e.name; issue = $e.issue; topic = $e.topic; commit = $e.commit
                sha256 = $e.sha256; bytes = $e.bytes; repo = $e.repo; createdAt = $e.at
                status = 'local-only'; attachments = @(); statusAt = $e.at
                legacy = [bool]($e.PSObject.Properties['legacy'] -and $e.legacy)
                recompressed = $false
                issueCopySha256 = $null
            }
        } elseif ($e.event -eq 'status' -and $states.Contains($key)) {
            $states[$key].status = $e.status
            $states[$key].statusAt = $e.at
            if ($e.PSObject.Properties['attachments'] -and $e.attachments) { $states[$key].attachments = @($e.attachments) }
        } elseif ($e.event -eq 'recompressed' -and $states.Contains($key)) {
            # 重新壓縮：檔案內容換成 WebP 版，狀態不變；issue 上的附件仍是第一次重新壓縮前的版本
            if (-not $states[$key].issueCopySha256) { $states[$key].issueCopySha256 = $e.previousSha256 }
            $states[$key].sha256 = $e.sha256
            $states[$key].bytes = $e.bytes
            $states[$key].recompressed = $true
        }
    }
    @($states.Values | ForEach-Object { [pscustomobject]$_ })
}

Export-ModuleMember -Function * -Variable ImageExtensions, PrecompressedExtensions, ArchiveStatuses
