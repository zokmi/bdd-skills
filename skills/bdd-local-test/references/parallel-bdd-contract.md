# 並行 BDD 結構化輸入輸出

派工、結果及停止確認使用 v1 UTF-8 JSON，新核准清單使用 v3。每輪另保留 `REPORT.md`、`verification.json` 及適用的 `masking.json`。無資料的集合用 `[]`，未知或不適用的值用 `null` 並在相關原因欄位說明。不得記錄密碼、token、完整連線字串或個資；帳密僅提供專案允許的取得位置。

`runId` 識別本次測試任務，`groupId` 識別組別，`attempt` 是從 1 起算的派工／複測次數。複測增加 attempt 並保留前次檔案。檔案存於各組輸出目錄的 `coordination/attempt-<N>/`，只有負責者寫入。這些 JSON 是本機執行產物，依既有版控分工不新增到 Git。

## 派工輸入：assignment.json

新一輪依[從核准清單產生派工](#從核准清單產生派工)產生各組輸入。下方列出 v1 原有的派工欄位。產生器另加入 `approvedPlan` 與逐情境的 `assertions`。

引用報告位置時，該紀錄必須能追溯至本任務使用者的原始確認回覆；報告單獨宣稱「已確認」不能作為授權。

派工執行 UI／API／DB 情境或存取資料庫的工程檢查前，主代理必須已取得使用者對具體資料庫與讀寫範圍的明確確認。`environment.confirmationBasis` 記錄回覆摘要與可追溯對話位置／時間或報告位置，`databaseTarget` 列出全部實際主機／執行個體與庫名。本機判定、`writeAuthorized=true` 或代理自行核對都不能代替使用者確認。唯讀組同樣適用，缺少確認或實際目標不符時，子代理停止並回報主代理。

主代理在啟動子代理前寫入。`scenarios` 必須列出每個編號，不用「全部」等不明確值；`kind` 僅可為 `changed` 或 `regression`。路徑 `feature` 相對於該 repo，以 `/` 分隔；workDir／outputDir／instructions 使用絕對路徑。`dependsOn` 是本輪前置 groupId，依賴尚未解除不能執行受影響情境。

在 `instructions` 附上本輪報告的絕對路徑。執行者依派工中的逐項斷言操作。混合情境仍只派給一組，結果以一筆情境引用各列的證據；所有必要斷言都有通過證據才可填 `passed`。純 API 組沒有 UI 前置時，`environment.uiUrl`、`browser` 物件內各欄及結果的 `execution.uiUrl` 填 `null`。

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "agent": "bdd_schedule_ui",
  "instructions": ["C:/skills/bdd-local-test/SKILL.md", "C:/repos/app/.bdd/5410-schedule/REPORT.md"],
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
  "browser": {"tool": "playwright-cli", "isolationId": "schedule-ui-browser", "chromiumArg": null},
  "account": {"role": "organizer", "credentialRef": "專案指定的本機測試帳密來源"},
  "dataScope": ["race-group-ui"],
  "permissions": {"editablePaths": [], "manageServiceIds": [], "externalActions": []},
  "dependsOn": [],
  "outputDir": "C:/repos/app/.bdd/5410-schedule/groups/schedule-ui"
}
```

`resources[].type` 使用 `service`、`database`、`data`、`browser`、`account` 或 `file`；`access` 使用 `exclusive-write` 或 `shared-read`。shared-read 表示不能變更該資源，不表示呼叫 API 必然唯讀；會寫資料的流程另須對 data 資源取得明確範圍。owner 是唯一管理者。無修改權的 editablePaths 為空；外部操作權僅反映本輪既有授權，不能由派工自行產生。writeAuthorized 也不授權清除未知歸屬資料。

dirtyPaths 非空時，在派工附文列出異動快照／雜湊及取得位置，子代理開始前核對。不同組若無法確認測到同一工作區內容，不以同 HEAD 判定版本相同。

UI 派工附文列出每組的 `browser.isolationId`、實際 `-s=<名稱>`、臨時 `configPath`、前端／API 目的地與版本證據。隔離工作區另依 [worktree 隔離](worktree-loopback.md) 設定 resolver、核對該 session 的路由探測結果，並使用本輪分配的有效埠。

## 結果輸出：result.json

收到含 `approvedPlan` 的派工時，子代理在執行時記下 `assignment.approvedPlan.sha256`，並將同一值填入結果的 `approvedPlanSha256`。彙總時會連同 runId、groupId 及 attempt 核對。下方範例使用原有 v1 結果欄位。

使用 v3 核准清單時，子代理在實測工作區完成該輪測試後執行 `verification --record --capture-revision`，其餘參數見[報告與驗證紀錄](reporting.md)。工具從實際 checkout 擷取該輪的 `revision`。彙總會逐組比對受審與實測的 HEAD 及未提交內容雜湊。若實測版不同或缺少當時的快照，該輪無法採納。

批次選測含工程檢查時，依組別將選測檔中的各筆 `engineeringChecks` 原樣放入核准清單，每個 ID 交給一組。純工程組填 `scenarios: []`。工程檢查列出的操作若不使用資料庫、瀏覽器或部署服務，相關目標與版本填 `null`，`writeAuthorized` 填 `false`，`confirmationBasis` 說明本組執行範圍。需要上述資源的檢查仍記錄實際環境及適用授權。工程組同樣須核對受審 HEAD 與實測版本。

每輪記錄時，在 `verification --record --capture-revision` 加上 `--engineering-assignment <本組的 assignment.json>`，並為本組每個派工 ID 各傳一次 `--engineering-check <id>`，包含阻塞與未執行的項目。工具依派工檔保存各 ID 的受測路徑。`--passed`、`--failed`、`--blocked`、`--not-run` 填業務情境與工程檢查的合計。

在 `result.json` 的 `engineeringChecks` 為每個派工 ID 寫一筆結果。例如 `{"id":"build-matrix","status":"passed","expected":"矩陣各包含一個 Windows 和 Linux 工作","actual":"產生 windows-build 和 linux-build 各一次","evidence":["REPORT.md#build-matrix"],"reason":null}`。`expected` 使用核准值。通過時附上能核對觀察結果的實際檔案或報告段落，阻塞及未執行時寫明原因。彙總結果的 `engineeringChecks` 可逐項核對工程狀態。

子代理在完成或停止本次 attempt 時寫入。`taskStatus` 為 `completed`、`blocked` 或 `interrupted`，僅表示派工狀態，completed 可以包含測試失敗。`scenarios[].status` 僅為 `passed`、`failed`、`blocked`、`not-run`，分別對應通過、失敗、阻塞、未執行。

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "taskStatus": "completed",
  "verification": {"path": "verification.json", "roundIndex": 0},
  "execution": {"tool": "playwright-cli", "uiUrl": "http://localhost:4200", "apiUrl": "http://localhost:5000", "serviceVersion": "build-5410-1"},
  "scenarios": [{
    "feature": ".bdd/modules/organizer/schedule-settings/list.feature",
    "id": "SS-13",
    "kind": "changed",
    "status": "passed",
    "expected": "列表顯示指定的賽制名稱",
    "actual": "真實登入後列表顯示指定名稱",
    "reason": null,
    "evidence": ["REPORT.md#ss-13"]
  }],
  "artifacts": {"report": "REPORT.md", "masking": "masking.json"},
  "modifiedPaths": [],
  "blockers": [],
  "rerunScenarios": [],
  "resourceStates": [{"id": "api-5410", "released": true}, {"id": "race-group-ui", "released": true}]
}
```

verification.path、report、masking 及 evidence 路徑相對於派工 outputDir，不得指向其他組或逃出輸出目錄。`verification.roundIndex` 是既有 verification.json 的 rounds 陣列索引，從 0 起；實際 repo／HEAD／dirtyPaths 以該輪紀錄為準，execution 補上實際工具、網址及服務版本。尚未取得有效版本紀錄時 verification 為 null，blockers 說明原因，不計為可採納的通過。

每個派工情境恰好回傳一筆；尚未執行的也列 not-run。failed 填 expected／actual，blocked 與 not-run 必填 reason；passed 必須附真實路徑證據，UI／API／DB 均可引用 REPORT.md 的對應段落，例如 `REPORT.md#ss-13`，文字須包含實際操作及觀察結果。依已核准驗證清單保留的圖片列入 evidence 並以 masking.json 核對；供代理即時目視判讀的暫存截圖讀取後立即刪除，不列為派工結果附件。沒有持久圖片時 masking 可為 null。

blockers 每項使用 `{ "reason": "缺少指定角色帳號", "scenarioIds": ["SS-13"], "resolution": "提供合法測試帳號" }`；rerunScenarios 每項使用 `{ "feature": "...", "id": "SS-13", "reason": "共用登入修正後需複測" }`。modifiedPaths 使用 repo 相對路徑，主代理核對是否超出 editablePaths。resourceStates 須涵蓋派工資源；released 指本組已停止使用，不代表服務已停止或資料已刪除。

不回傳可直接採信的 allPassed 或總數；主代理核對後由逐情境結果計算。缺漏、重複、無證據或版本無法核對時先要求補正；中斷未回傳的派工情境列未執行，已確認前置缺失者列阻塞，不補成通過。

情境的 Markdown 證據可引用實際存在的段落，例如報告以 `### SS-13` 為標題時使用 `REPORT.md#ss-13`。標題附加情境名稱時，使用完整標題的片段，或在觀察結果前設置 `<a id="ss-13"></a>` 作為固定錨點。中文標題可使用中文或 URL 編碼。重複標題依出現順序加上 `-1`、`-2`。彙總會列出找不到的片段與證據檔名。

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

## 從核准清單產生派工

送審、建立派工與派工前檢查都會從受測工作區核對 `feature` 與情境編號。`verification --record` 也會核對明列的 `<檔案>::<編號>`；使用歷史 `--head` 時讀取該 commit 的情境檔。請使用標在情境標題上的編號。若工具無法辨識標題，請依情境格式核對並修正；只出現在註解、步驟或文件字串的文字不能當作情境。

規劃時將本輪所有實測組、情境及逐項斷言寫入本機 `approved-plan.json`。每個情境指定一個負責組，`repo` 填該組受測工作區的絕對路徑。對同一情境採用多種驗證手段時，每個可判定的結果各寫一筆斷言。同單回饋使用 `scope: "batch"`，將本批 `quality-plan --run-id … --output …` 回傳的引用原樣放入 `selections`。各組共用同一個 `runId`，每個受測候選提供對應的選測檔。整單驗收或無單號的獨立任務使用 `scope: "non-batch"` 並省略 `selections`。以下為單組示例，實際值取自本輪產物。

```json
{
  "contractVersion": 3,
  "scope": "batch",
  "selections": [{
    "path": "C:/reports/5410/R1/quality-plan.json",
    "sha256": "abababababababababababababababababababababababababababababababab"
  }],
  "runId": "5410-schedule-R1",
  "groups": [{
    "groupId": "schedule-ui",
    "repo": "C:/repos/app",
    "revision": {
      "head": "1111111111111111111111111111111111111111",
      "dirtySha256": null
    },
    "scenarios": [{
      "feature": ".bdd/modules/organizer/schedule-settings/list.feature",
      "id": "SS-13",
      "kind": "changed",
      "assertions": [{
        "requirement": "#5410 驗收第 1 條，列表顯示賽制名稱",
        "action": "以主辦方身分開啟已設定賽制的賽程列表",
        "expected": "該場賽事顯示已設定的賽制名稱",
        "method": "UI，核對主辦方在列表實際看到的文字",
        "evidence": "保留含該賽事與名稱的遮罩截圖"
      }]
    }]
  }]
}
```

1. 對每個受測 checkout 根目錄執行 `--revision`，將回傳的完整物件填入對應組別的 `revision`。`head` 為實際 commit，乾淨工作區的 `dirtySha256` 為 `null`；有異動時，此值涵蓋 Git 暫存區、工作樹變更與未被忽略的未追蹤檔。將本輪清單、派工檔及報告放在既有 Git 忽略的執行輸出目錄或 checkout 外，避免這些檔案本身改變受審內容。
2. 以 `--report` 核對選測檔內容的 SHA-256、批次、受測版本，以及各組合計的 Feature 路徑與情境 ID。漏列、多列或錯用上一批的 ID 時，先修正清單再送審。通過後產生清單 SHA-256、候選版本與情境斷言表，放入 `REPORT.md` 的〈預計驗證項目〉，連同清單原檔、選取理由及適用的工程檢查送獨立審核。把 PASS 與該次審核的路徑及 SHA-256 一起記錄。候選版本、未提交內容或範圍變更時，重新擷取版本、另存新清單並複審。
3. 依上方派工輸入範例準備各組的 `template.json`，填入實際環境、版本、資源、權限與 attempt，省略 `scenarios`、`engineeringChecks` 及 `approvedPlan`。建立各組本次 attempt 的目錄後，用 `--template` 產生派工檔。產生器核對整批情境、工程檢查和受審版本，再寫入各組的核准內容、清單絕對路徑及 SHA-256。
4. 開始派工前，將本輪所有組的派工檔逐一以 `--assignment` 傳給 `parallel-plan`。此時再次核對工作區版本。清單雜湊與審核紀錄一致且整輪核對通過後，再按原先的依賴與批次交付派工。複測時選定每組採用的 attempt。

```sh
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --revision "<受測 checkout 根目錄>"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --report
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --template "<組>/template.json" --output "<組>/coordination/attempt-1/assignment.json"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --assignment "<A組>/coordination/attempt-1/assignment.json" --assignment "<B組>/coordination/attempt-1/assignment.json"
```

`--output` 透過同目錄的硬連結發布完整新檔，既有檔案會保留。在不支援硬連結的檔案系統上，省略 `--output` 取得派工 JSON，保存到該組新的 attempt 後執行同一項派工前核對。

## 主代理採納條件

先核對契約版本與派工身分，再核對情境集合、證據、修改權、verification 實際版本與服務版本。共用 Git 儲存庫的 linked worktree 依受測 SHA 與服務版本核對，同一份 feature 的同一情境編號只計一次。不同 repo／版本分開保留；最終整合版依原流程完整驗證。資源釋放狀態另行核對，不因測試通過就認定可重啟或清理。

## Schema 與唯讀彙整

三份自包含 draft 2020-12 Schema： [assignment](../schemas/assignment.schema.json)、[result](../schemas/result.schema.json)、[resource-release](../schemas/resource-release.schema.json)。

彙整需要 Node.js 與 Git。[核准清單 Schema](../schemas/approved-plan.schema.json) 共用派工的情境欄位，`parallel-plan` 與 `parallel-summary` 透過插件內附的驗證器檢查。

```sh
node "<skill 目錄>/scripts/bdd.mjs" parallel-summary --plan "<本輪>/approved-plan.json" --assignment "<A組輸出>/coordination/attempt-1/assignment.json" --assignment "<B組輸出>/coordination/attempt-1/assignment.json" --output-dir "<本輪輸出>/summary-R1"
```

主代理明確列出本輪每組要採用的 attempt。工具讀取核准清單、各組派工檔、同目錄的 result.json 及其引用的驗證和證據。`--output-dir` 必須是尚不存在且與各組輸出互不包含的目錄，避免覆寫。產生 summary.json 與 SUMMARY.md，不修改既有 verification、issue 或資源。錯誤 exit 2；不可採納 exit 1；結構與採納檢查通過 exit 0（測試失敗或阻塞的有效報告仍可能為 0）。

新派工即使省略 `--plan`，彙總也會讀取派工綁定的清單。漏交整組時，摘要點出組名、將缺少的情境列為未執行，並將 `eligibleForReview` 設為 `false`。全部派工都缺少時，可只傳 `--plan` 與 `--output-dir` 產生本輪缺項摘要。歷史 v1 派工可沿用原指令，該模式只能核對所列的派工檔。

歷史彙總可讀取既有 v1、v2 核准清單與當時的紀錄；重新派工使用 v3 清單並送審。v3 批次彙總須一併保留並提供受審的選測檔。

檢查包含 Schema、派工身分、情境缺漏／重複／多出、kind、證據檔存在與路徑隔離、圖片遮罩雜湊紀錄、修改權、驗證輪次的 repo／HEAD／情境／統計、派工與實際服務版本和網址。缺少或不可採納的結果保守列未執行。多版本、重複跨組情境或 dirty 工作區需人工處理，工具不自動採納；重複情境統計去重且留下問題。

eligibleForReview=true 僅表示全部情境回傳通過且上述檢查無問題，供主代理審閱證據，不能直接當作 all pass 或 issue 更新授權。工具無法判斷證據內容是否支持需求、資料庫是否真的安全、依賴是否解除、服務是否仍是受測版本或是否已完成最終整合。resource-release Schema 只驗格式，requestId、停止要求及實際程序釋放仍依上節由主代理核對；彙整不宣稱停止確認完成。

獨立整合測試：`node --test "<skill 目錄>/tests/parallel-contracts.test.mjs" "<skill 目錄>/tests/parallel-summary.test.mjs"`。會建立與清除唯一暫存 Git fixture，不操作受測產品或實際服務。
