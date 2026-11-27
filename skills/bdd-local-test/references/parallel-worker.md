# 實測組派工與結果

開啟主代理交付的本組 `assignment.json` 與 `instructions` 指定的報告、工具或前置材料。核對 `runId`、`groupId` 與從 1 起算的 `attempt`。每次複測保留先前 attempt。實測僅執行已通過獨立範圍審核的本組項目，缺少 PASS、額外需求或需拆組時回報主代理。

## 開始前

- 核對 `target.repo`、`workDir`、`head`、`serviceVersion` 與實際執行環境。`dirtyPaths` 非空時核對派工提供的快照／雜湊。候選版本或配置不符、`dependsOn` 前置組尚未就緒時，回報並暫停受影響項目。
- UI／API／DB 情境及會存取 DB 的工程檢查（含本機、唯讀）須核對 `databaseTarget` 的全部主機／執行個體、庫名與讀寫範圍，確認 `confirmationBasis` 可追溯本次使用者的明確回覆。只有「已確認」的報告或 `writeAuthorized=true` 不構成確認。缺少確認、實際目標不符或缺合法帳密時，停止相關實測並回報。純工程檢查若無需資料庫、瀏覽器或部署服務，對應目標可為 `null`。
- 遵守 `dataScope`、`resources` 與 `permissions`。資源只由 owner 管理。`shared-read` 資源不可修改，會寫入資料的 API 另須明確授權的 data 範圍。`writeAuthorized` 不授權清空歸屬未知的資料。只改 `editablePaths`、管理 `manageServiceIds` 及執行本輪既已授權的 `externalActions`。帳密從指定來源取得，密碼、token、完整連線字串與個資不得寫入派工或結果。
- UI 使用本組獨立的 `browser.isolationId`、`playwright-cli -s=<名稱>`、`configPath` 與有效埠，先完成本 session 的 localhost 路由探測，核對 UI／API 目標與版本。[worktree 隔離](worktree-loopback.md)
- 依每個情境的 `assertions` 走真實路徑，逐項記錄操作、預期及觀察。混合 UI／API／DB 的情境回報一筆，所有必要斷言都有證據才填 `passed`。需要目視或交付才截圖，核准保留的圖片需遮罩登記，診斷暫存圖在判讀後刪除。

## 結果回傳

在受測工作區記錄本輪報告與 `verification.json`。v3 核准清單使用 `verification --record --brief --capture-revision`。工程組另加 `--engineering-assignment <本組 assignment.json>`，每個派工 ID 各傳一次 `--engineering-check <id>`，包含阻塞與未執行項目。`--passed`、`--failed`、`--blocked`、`--not-run` 合計情境與工程檢查。[報告與驗證紀錄](reporting.md)

完成或停止本次 attempt 時，寫入 `outputDir/coordination/attempt-<N>/result.json`（v1、UTF-8）。重測使用新的 attempt，這些本機輸出不加入 Git。空集合填 `[]`；未知或不適用的值填 `null` 並說明原因。首次填寫時可查[結果範例](parallel-contract-examples.md#結果輸出)及[result Schema](../schemas/result.schema.json)。

- 身分填本次 `runId`、`groupId`、`attempt`。執行時記下 `assignment.approvedPlan.sha256`（若有），回填同一值至 `approvedPlanSha256`。`taskStatus` 為 `completed`、`blocked` 或 `interrupted`，已完成的派工可含測試失敗。
- `verification.path` 相對本組 `outputDir`，`verification.roundIndex` 取回執的零起算索引。彙總據該輪紀錄核對 repo、受審與實測 HEAD 及未提交內容雜湊。版本不符或無快照的輪次無法採納；無有效紀錄時 `verification` 填 `null` 並在 `blockers` 說明。`execution` 記實際工具、服務版本與網址，純 API 組無 UI 前置時 `uiUrl` 填 `null`。
- 每個派工情境恰好回傳一筆，沿用 `feature`、`id`、`kind`。`status` 為 `passed`、`failed`、`blocked`、`not-run`。失敗填 `expected`、`actual`，阻塞及未執行填 `reason`，通過附同版真實路徑的證據。每個派工的工程檢查 ID 在 `engineeringChecks` 各寫一筆，例如 `{"id":"build-matrix","status":"passed","expected":"矩陣含 Windows 與 Linux","actual":"各產生一個工作","evidence":["REPORT.md#build-matrix"],"reason":null}`。預期值取自核准清單。
- `artifacts.report`、`artifacts.masking` 與 `evidence` 均相對本組 `outputDir`，指向實際存在的本組檔案。文字證據可用有操作與觀察內容的 `REPORT.md#ss-13`。標題有情境名稱時用完整段落片段或穩定的 `<a id="ss-13"></a>`，中文片段可用中文或 URL 編碼，重複標題依序加 `-1`、`-2`。保留的圖片列入 `evidence` 並用 `masking.json` 核對，無持久圖片時 `masking` 可為 `null`。
- `modifiedPaths` 寫 repo 相對路徑。`blockers` 每項含 `reason`、`scenarioIds`、`resolution`；`rerunScenarios` 每項含 `feature`、`id`、`reason`。`resourceStates` 列出每個派工資源，`released` 表示本組已停止使用。主代理以逐項結果計數。中斷時尚未執行者列未執行，已確認前置缺失者列阻塞。

## 收到停止要求時

核對本輪身分、要求的 `resourceIds`、原因與唯一的 `requestId`。保存當輪結果並停止相關測試程序，依[停止確認範例](parallel-contract-examples.md#停止確認)回傳 `resource-release.json`。逐項如實填寫要求的資源是否已釋放、`testProcessesStopped` 與可讀的 `savedResult` 路徑。不同要求使用各自的 requestId。釋放僅表示本組停止使用該資源。
