# 並行 BDD 結構化輸入輸出

本契約用於代理協調，不取代既有 `REPORT.md`、`verification.json` 或 `masking.json`。使用 UTF-8 JSON，`contractVersion` 固定為 `1`；以下範例全部欄位均須提供。無資料的集合用 `[]`，未知或不適用的值用 `null` 並在相關原因欄位說明，不猜測。不得記錄密碼、token、完整連線字串或個資；帳密僅提供專案允許的取得位置。

`runId` 識別本次測試任務，`groupId` 識別組別，`attempt` 是從 1 起算的派工／複測次數。複測增加 attempt 並保留前次檔案。檔案存於各組輸出目錄的 `coordination/attempt-<N>/`，只有負責者寫入。這些 JSON 是本機執行產物，依既有版控分工不新增到 Git。

## 派工輸入：assignment.json

引用報告位置時，該紀錄必須能追溯至本任務使用者的原始確認回覆；報告單獨宣稱「已確認」不能作為授權。

實測派工前，主代理必須已取得使用者對具體資料庫與讀寫範圍的明確確認；`environment.confirmationBasis` 記錄回覆摘要與可追溯對話位置／時間或報告位置，`databaseTarget` 列出全部實際主機／執行個體與庫名。本機判定、`writeAuthorized=true` 或代理自行核對都不能代替使用者確認。唯讀組同樣適用；缺少確認或實際目標不符時，子代理停止並回報主代理，不執行情境。

主代理在啟動子代理前寫入。`scenarios` 必須列出每個編號，不用「全部」等不明確值；`kind` 僅可為 `changed` 或 `regression`。路徑 `feature` 相對於該 repo，以 `/` 分隔；workDir／outputDir／instructions 使用絕對路徑。`dependsOn` 是本輪前置 groupId，依賴尚未解除不能執行受影響情境。

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "agent": "bdd_schedule_ui",
  "instructions": ["C:/skills/bdd-local-test/SKILL.md"],
  "requirements": [{"source": "issue:5410", "text": "列表顯示需求指定的賽制名稱"}],
  "scenarios": [{"feature": ".bdd/modules/organizer/schedule-settings/list.feature", "id": "SS-13", "kind": "changed"}],
  "target": {
    "repo": "C:/repos/app",
    "workDir": "C:/repos/app",
    "head": "1111111111111111111111111111111111111111",
    "dirtyPaths": [],
    "serviceVersion": "build-5410-1"
  },
  "environment": {
    "uiUrl": "http://localhost:4200",
    "apiUrl": "http://localhost:5000",
    "databaseTarget": "(localdb)\\MSSQLLocalDB / App_Test",
    "writeAuthorized": true,
    "confirmationBasis": "使用者於本任務對話明確回覆：確認上述 App_Test 與本輪資料讀寫範圍，可以測試；詳見 REPORT.md 資料庫環境確認，本輪已核對設定未變"
  },
  "resources": [{"id": "api-5410", "type": "service", "owner": "main", "access": "shared-read"}, {"id": "race-group-ui", "type": "data", "owner": "schedule-ui", "access": "exclusive-write"}],
  "browser": {"tool": "playwright-mcp", "isolationId": "schedule-ui-browser", "chromiumArg": null},
  "account": {"role": "organizer", "credentialRef": "專案指定的本機測試帳密來源"},
  "dataScope": ["race-group-ui"],
  "permissions": {"editablePaths": [], "manageServiceIds": [], "externalActions": []},
  "dependsOn": [],
  "outputDir": "C:/repos/app/.bdd/5410-schedule/groups/schedule-ui"
}
```

`resources[].type` 使用 `service`、`database`、`data`、`browser`、`account` 或 `file`；`access` 使用 `exclusive-write` 或 `shared-read`。shared-read 表示不能變更該資源，不表示呼叫 API 必然唯讀；會寫資料的流程另須對 data 資源取得明確範圍。owner 是唯一管理者。無修改權的 editablePaths 為空；外部操作權僅反映本輪既有授權，不能由派工自行產生。writeAuthorized 也不授權清除未知歸屬資料。

dirtyPaths 非空時，在派工附文列出異動快照／雜湊及取得位置，子代理開始前核對。不同組若無法確認測到同一工作區內容，不以同 HEAD 判定版本相同。

browser.isolationId 是協調識別，不會自動建立 MCP session。UI 派工附文須列臨時 configPath、實際 server／工具前綴及前端／API 導轉與版本確認證據，依 [worktree 隔離](worktree-loopback.md) 產生設定並確認連線。不得只更改 tool 名稱就視為已隔離；並行 UI 各用獨立 MCP，原 localhost 網址與埠號保持不變。

## 結果輸出：result.json

子代理在完成或停止本次 attempt 時寫入。`taskStatus` 為 `completed`、`blocked` 或 `interrupted`，僅表示派工狀態，completed 可以包含測試失敗。`scenarios[].status` 僅為 `passed`、`failed`、`blocked`、`not-run`，分別對應通過、失敗、阻塞、未執行。

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "taskStatus": "completed",
  "verification": {"path": "verification.json", "roundIndex": 0},
  "execution": {"tool": "playwright-mcp", "uiUrl": "http://localhost:4200", "apiUrl": "http://localhost:5000", "serviceVersion": "build-5410-1"},
  "scenarios": [{
    "feature": ".bdd/modules/organizer/schedule-settings/list.feature",
    "id": "SS-13",
    "kind": "changed",
    "status": "passed",
    "expected": "列表顯示指定的賽制名稱",
    "actual": "真實登入後列表顯示指定名稱",
    "reason": null,
    "evidence": ["evidence/R1_SS-13_列表名稱.png"]
  }],
  "artifacts": {"report": "REPORT.md", "masking": "masking.json"},
  "modifiedPaths": [],
  "blockers": [],
  "rerunScenarios": [],
  "resourceStates": [{"id": "api-5410", "released": true}, {"id": "race-group-ui", "released": true}]
}
```

verification.path、report、masking 及 evidence 路徑相對於派工 outputDir，不得指向其他組或逃出輸出目錄。`verification.roundIndex` 是既有 verification.json 的 rounds 陣列索引，從 0 起；實際 repo／HEAD／dirtyPaths 以該輪紀錄為準，execution 補上實際工具、網址及服務版本。尚未取得有效版本紀錄時 verification 為 null，blockers 說明原因，不計為可採納的通過。

每個派工情境恰好回傳一筆；尚未執行的也列 not-run。failed 填 expected／actual，blocked 與 not-run 必填 reason；passed 必須附真實路徑證據，API／DB 可引用 REPORT.md 的對應段落，例如 `REPORT.md#ss-13`。圖片遮罩是否有效以 masking.json 核對，不靠回傳文字自稱。無圖片時 masking 可為 null。

blockers 每項使用 `{ "reason": "缺少指定角色帳號", "scenarioIds": ["SS-13"], "resolution": "提供合法測試帳號" }`；rerunScenarios 每項使用 `{ "feature": "...", "id": "SS-13", "reason": "共用登入修正後需複測" }`。modifiedPaths 使用 repo 相對路徑，主代理核對是否超出 editablePaths。resourceStates 須涵蓋派工資源；released 指本組已停止使用，不代表服務已停止或資料已刪除。

不回傳可直接採信的 allPassed 或總數；主代理核對後由逐情境結果計算。缺漏、重複、無證據或版本無法核對時先要求補正；中斷未回傳的派工情境列未執行，已確認前置缺失者列阻塞，不補成通過。

## 停止確認：resource-release.json

主代理送出停止要求時提供唯一 requestId、runId／groupId／attempt、resourceIds 與原因。子代理保存當輪結果並停止相關測試程序後回傳下列訊息；不同停止要求不得重用 requestId。

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "requestId": "pause-login-fix-1",
  "resources": [{"id": "api-5410", "released": true}],
  "testProcessesStopped": true,
  "savedResult": "coordination/attempt-1/result.json",
  "reason": "已保存當輪證據並停止使用共用 API"
}
```

主代理須核對 requestId 與本輪身分、所要求資源完整列出且全部 released=true、testProcessesStopped=true，並確認結果檔可讀，才視為停止確認。確認只對該要求列出的資源有效。代理中斷或無回應時由主代理實查程序及資源是否釋放並記錄依據，不捏造子代理確認。

## 主代理採納條件

先核對契約版本與派工身分，再核對情境集合、證據、修改權、verification 實際版本與服務版本。不同 repo／版本分開保留，不合併成共同 SHA；最終整合版依原流程完整驗證。資源釋放狀態另行核對，不因測試通過就認定可重啟或清理。

## Schema 與唯讀彙整

三份自包含 draft 2020-12 Schema： [assignment](../schemas/assignment.schema.json)、[result](../schemas/result.schema.json)、[resource-release](../schemas/resource-release.schema.json)。PowerShell 7.4 以上可用 `Test-Json -Json (Get-Content <檔案> -Raw) -SchemaFile <對應 Schema>` 驗證。

彙整使用 PowerShell 7.4+ 與 Git，不需要安裝 JSON 套件：

```powershell
& "<skill 目錄>/scripts/summarize-parallel-bdd.ps1" -AssignmentFiles @(
  "<A組輸出>/coordination/attempt-1/assignment.json",
  "<B組輸出>/coordination/attempt-1/assignment.json"
) -OutputDir "<本輪輸出>/summary-R1"
```

主代理明確列出本輪每組、要採用的 attempt；工具只讀派工與同目錄的 result.json，不自動猜最新輪次。OutputDir 必須是尚不存在且與各組輸出互不包含的目錄，避免覆寫。產生 summary.json 與 SUMMARY.md，不修改既有 verification、issue 或資源。錯誤 exit 2；不可採納 exit 1；結構與採納檢查通過 exit 0（測試失敗或阻塞的有效報告仍可能為 0）。

檢查包含 Schema、派工身分、情境缺漏／重複／多出、kind、證據檔存在與路徑隔離、圖片遮罩雜湊紀錄、修改權、驗證輪次的 repo／HEAD／情境／統計、派工與實際服務版本和網址。缺少或不可採納的結果保守列未執行。多版本、重複跨組情境或 dirty 工作區需人工處理，工具不自動採納；重複情境統計去重且留下問題。

eligibleForReview=true 僅表示全部情境回傳通過且上述檢查無問題，供主代理審閱證據，不能直接當作 all pass 或 issue 更新授權。工具無法判斷證據內容是否支持需求、資料庫是否真的安全、依賴是否解除、服務是否仍是受測版本或是否已完成最終整合。resource-release Schema 只驗格式，requestId、停止要求及實際程序釋放仍依上節由主代理核對；彙整不宣稱停止確認完成。

獨立整合測試：`pwsh -NoProfile -File "<skill 目錄>/tests/Test-ParallelBdd.ps1"`。會建立與清除唯一暫存 Git fixture，不操作受測產品或實際服務。
