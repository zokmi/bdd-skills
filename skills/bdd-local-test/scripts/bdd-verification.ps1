<#
.SYNOPSIS
  記錄 BDD 實測當下的 git 版本（-Record），或比對既有紀錄與目前 repo 是否仍一致（-Check），
  讓報告跟著 cherry-pick／merge 同步到別的分支或別的 repo 時，能判斷要不要重新驗證。

.DESCRIPTION
  紀錄檔是輸出資料夾裡的 verification.json，與 REPORT.md 一起保存於本機及完整封存，不進版控。
  跨分支或 repo 驗證時，從本機輸出或封存還原紀錄，再核對受測版本。
  每一輪實測結束時 -Record 追加一筆 rounds；-Check 讀最後一筆，與目前 repo 比對：

    - repo 是否相同（origin URL）
    - 紀錄的 HEAD 是否就是目前 HEAD、相關檔案有沒有未提交異動
    - 每個受測 commit 在目前 repo 的對應：
        same     同一個 SHA 且是目前 HEAD 的祖先
        patch    SHA 不同但 patch-id 相同（cherry-pick 過來，內容一致）
        subject  只找到同標題的 commit，內容有差異（通常是解衝突或手動改寫）
        missing  找不到，這個異動沒有同步過來
    - 受測檔案在目前 HEAD 的 blob 是否與紀錄時相同
    - 本輪跑過的模組情境檔（scenarios）在目前 HEAD 的 blob 是否與紀錄時相同

  判定（verdict）：
    current       同 repo、同 HEAD、相關檔案無未提交異動 → 報告仍有效
    still-valid   同 repo、HEAD 前進了，但受測 commit 都在、受測檔案內容未變 → 報告仍有效，註記新 HEAD 即可
    rerun         其餘情況（跨 repo、cherry-pick、檔案有變、有 commit 缺漏）→ 必須重新驗證

.PARAMETER Dir
  BDD 輸出資料夾（例如 .bdd/94541-resign-rollback-detach）。

.PARAMETER Record
  記錄模式。需搭配 -Base 或 -Commits。

.PARAMETER Check
  比對模式。

.PARAMETER CaptureRevision
  記錄模式。將實測 checkout 的 HEAD 與未提交變更雜湊寫入本輪紀錄，供 v2 核准清單彙總核對。

.PARAMETER Base
  記錄模式：受測範圍的基準。列出 Base..Head 的非 merge commit，檔案範圍另含每次合併相對第一個父提交的變動及自共同祖先到 Head 的整合差異。

.PARAMETER Commits
  記錄模式：直接指定受測 commit（逗號分隔），優先於 -Base。

.PARAMETER Head
  記錄模式：受測版本，預設 HEAD。

.PARAMETER Passed / Failed / Blocked / NotRun
  記錄模式：本輪各結果的情境數。

.PARAMETER Note
  記錄模式：本輪的一句說明（例如「自 upstream 同步後複測」）。

.PARAMETER ChangedScenarios
  記錄模式：本輪新增或修改的模組情境檔（repo 相對路徑）。每項可寫「<路徑>」或「<路徑>::<編號>,<編號>」，未列編號時取檔內所有情境；可用 ; 串多項。

.PARAMETER RegressionScenarios
  記錄模式：本輪沒有修改、挑來回歸的模組情境檔，格式同 -ChangedScenarios。

.PARAMETER SearchDepth
  比對模式：以 patch-id／標題搜尋對應 commit 時，往回找的 commit 數上限，預設 3000。

.OUTPUTS
  JSON。-Check 的 exit code：0 = current／still-valid、1 = rerun、2 = 紀錄不存在或參數錯誤。

.EXAMPLE
  pwsh -File bdd-verification.ps1 -Record -Dir .bdd/94541-x -Base develop -Passed 28
  pwsh -File bdd-verification.ps1 -Check -Dir .bdd/94541-x
#>
param(
    [Parameter(Mandatory)][string]$Dir,
    [switch]$Record,
    [switch]$Check,
    [string]$Base,
    [string[]]$Commits = @(),
    [string]$Head = 'HEAD',
    [int]$Passed = 0,
    [int]$Failed = 0,
    [int]$Blocked = 0,
    [int]$NotRun = 0,
    [string]$Note = '',
    [string[]]$ChangedScenarios = @(),
    [string[]]$RegressionScenarios = @(),
    [int]$SearchDepth = 3000,
    [switch]$CaptureRevision
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cliArgs = @('verification', "--dir=$Dir", "--head=$Head", "--passed=$Passed", "--failed=$Failed",
    "--blocked=$Blocked", "--not-run=$NotRun", "--search-depth=$SearchDepth")
if ($Record) { $cliArgs += '--record' }
if ($CaptureRevision) { $cliArgs += '--capture-revision' }
if ($Check) { $cliArgs += '--check' }
if ($Base) { $cliArgs += "--base=$Base" }
if ($Note) { $cliArgs += "--note=$Note" }
foreach ($ref in $Commits) { $cliArgs += "--commits=$ref" }
foreach ($entry in $ChangedScenarios) { $cliArgs += "--changed-scenarios=$entry" }
foreach ($entry in $RegressionScenarios) { $cliArgs += "--regression-scenarios=$entry" }
& node (Join-Path $PSScriptRoot 'bdd.mjs') @cliArgs
exit $LASTEXITCODE
