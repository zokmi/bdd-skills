# 並行 BDD 結構化輸入輸出

主代理用本契約準備派工、核對停止要求與採納結果。已取得本組 `assignment.json` 的實測子代理直接使用[實測組指引](parallel-worker.md)。獨立審核者取得本輪清單、版本與逐項斷言表，依本次受派的[情境審核](scenario-review.md#子代理指示範本)或[實測範圍審核](execution-workflow.md#實測範圍審核)查核。需要建立或核對 JSON 格式時再讀[契約範例](parallel-contract-examples.md)。

派工、結果及停止確認使用 v1 UTF-8 JSON，新核准清單使用 v3。空集合用 `[]`，未知或不適用的值用 `null` 並說明原因。憑證僅提供已授權的取得位置，檔案中不得包含密碼、token、完整連線字串或個資。

## 派工輸入：assignment.json

1. 主代理在啟動子代理前，從同一份[核准清單](#從核准清單產生派工)產生各組輸入。`runId` 識別任務、`groupId` 識別組別、`attempt` 從 1 起算。複測增加 attempt，保留原檔。每組由負責者寫入本機 `outputDir/coordination/attempt-<N>/`，不加入 Git。[派工範例](parallel-contract-examples.md#派工輸入)
2. `scenarios` 逐一列出情境 ID、repo 相對的 `feature` 路徑（以 `/` 分隔）及 `kind`（`changed` 或 `regression`）。產生器加入 `approvedPlan` 與逐情境的 `assertions`。同一情境的不同驗證手段交同一組。批次選測的 `engineeringChecks` 逐筆原樣分配，每個 ID 只交一組，純工程組用 `scenarios: []`。
3. 填入實際 `target`、`environment`、`resources`、`permissions` 與前置組 `dependsOn`。`workDir`、`outputDir` 與 `instructions` 用絕對路徑。在 `instructions` 附上[實測組指引](parallel-worker.md)與本輪 `REPORT.md` 的實際路徑。派工交付本組的 `assignment.json` 及工作所需資料。
4. UI／API／DB 情境與存取資料庫的工程檢查派工前，主代理須取得使用者對具體目標與讀寫範圍的明確確認，包含唯讀組。`databaseTarget` 列出所有實際主機／執行個體及庫名，`confirmationBasis` 記下對話回覆及位置／時間。引用報告時須能追溯原始確認。純工程組未用到的資料庫、瀏覽器、服務目標與版本填 `null`，無資料庫操作時填 `writeAuthorized: false` 並在 `confirmationBasis` 說明執行範圍。
5. 資源指定唯一 owner。`resources[].type` 可為 `service`、`database`、`data`、`browser`、`account` 或 `file`。`access` 為 `exclusive-write` 或 `shared-read`。會寫資料的 API 流程另列取得授權的 data 範圍，外部操作須有本輪既有授權。無修改權時 `editablePaths` 用空陣列。
6. 工作區有未提交異動時附快照／雜湊及位置。UI 派工列出 `browser.isolationId`、具名 CLI session、`configPath`、有效埠與前端／API 的目的地和版本證據。純 API 組無 UI 前置時，`environment.uiUrl` 和 `browser` 各欄填 `null`。[worktree 隔離](worktree-loopback.md)

## 結果輸出：result.json

實測組依[結果回傳](parallel-worker.md#結果回傳)寫入逐項結果、實測版本與證據。主代理依[採納條件](#主代理採納條件)核對，每個受派情境與工程檢查各有一筆結果。[結果範例](parallel-contract-examples.md#結果輸出)

## 停止確認：resource-release.json

主代理發出停止要求時提供唯一 `requestId`、`runId`／`groupId`／`attempt`、`resourceIds` 與原因。核對[停止回覆](parallel-worker.md#收到停止要求時)的身分與 requestId，要求的所有資源均須列出且 `released=true`、`testProcessesStopped=true`、結果檔可讀，才可確認已釋放這些資源。代理中斷或無回應時，實查程序與資源並記錄依據。[停止確認範例](parallel-contract-examples.md#停止確認)

## 從核准清單產生派工

送審、建立派工與派工前檢查都會從受測工作區核對 `feature` 與情境編號。`verification --record` 也會核對明列的 `<檔案>::<編號>`；使用歷史 `--head` 時讀取該 commit 的情境檔。請使用標在情境標題上的編號。若工具無法辨識標題，請依情境格式核對並修正；只出現在註解、步驟或文件字串的文字不能當作情境。

規劃時將本輪所有實測組、情境及逐項斷言寫入本機 `approved-plan.json`。每個情境指定一個負責組，`repo` 填該組受測工作區的絕對路徑。對同一情境採用多種驗證手段時，每個可判定的結果各寫一筆斷言。同單回饋使用 `scope: "batch"`，將本批 `quality-plan --run-id … --output …` 回傳的引用原樣放入 `selections`。各組共用同一個 `runId`，每個受測候選提供對應的選測檔。整單驗收或無單號的獨立任務使用 `scope: "non-batch"` 並省略 `selections`。[單組核准清單範例](parallel-contract-examples.md#核准清單)

1. 對每個受測 checkout 根目錄執行 `--revision`，將回傳的完整物件填入對應組別的 `revision`。`head` 為實際 commit，乾淨工作區的 `dirtySha256` 為 `null`；有異動時，此值涵蓋 Git 暫存區、工作樹變更與未被忽略的未追蹤檔。將本輪清單、派工檔及報告放在既有 Git 忽略的執行輸出目錄或 checkout 外，避免這些檔案本身改變受審內容。
2. 以 `--report --output` 核對選測檔 SHA-256、批次、受測版本、Feature 路徑與情境 ID，將完整逐項表寫入本輪新檔。主代理用工具把該檔原文插入 `REPORT.md`〈預計驗證項目〉，交接用 JSON 回執中的 `reportPath` 與 `approvedPlan`。獨立審核者讀完整表格、清單原檔、選取理由與適用的工程檢查，記錄 PASS 對應的清單路徑及 SHA-256。候選版本、未提交內容或範圍變更時，重新擷取版本、另存新清單並複審。省略 `--output` 時，表格會印至 stdout。
3. 依[派工輸入範例](parallel-contract-examples.md#派工輸入)準備各組的 `template.json`，填入實際環境、版本、資源、權限與 attempt，省略 `scenarios`、`engineeringChecks` 及 `approvedPlan`。多組派工使用 `--templates` 一次產生整份清單內的所有組別。單獨產生一組可建立該組本次 attempt 的目錄，再用 `--template` 輸出。
4. 開始派工前，將本輪所有組的派工檔逐一以 `--assignment` 傳給 `parallel-plan`。此時再次核對工作區版本。清單雜湊與審核紀錄一致且整輪核對通過後，再按原先的依賴與批次交付派工。複測時選定每組採用的 attempt。

```sh
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --revision "<受測 checkout 根目錄>"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --report --output "<本輪>/review-table.md"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --templates "<本輪>/templates.json" --output-dir "<本輪>/dispatch-R1"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --template "<組>/template.json" --output "<組>/coordination/attempt-1/assignment.json"
node "<skill 目錄>/scripts/bdd.mjs" parallel-plan --plan "<本輪>/approved-plan.json" --assignment "<A組>/coordination/attempt-1/assignment.json" --assignment "<B組>/coordination/attempt-1/assignment.json"
```

`templates.json` 是每組模板檔路徑組成的 JSON 陣列，例如 `["templates/ui.json", "templates/api.json"]`。相對路徑從清單所在目錄解析。每個核准組別須出現一次，各模板的 `outputDir` 填寫新批次目錄下 `groups/<組目錄>` 的絕對路徑，例如 `C:/reports/5410/dispatch-R1/groups/ui`。保留新批次的目錄名稱供工具建立。

工具一起核對模板、組別、Feature 和情境編號，並在發布前複核清單、選測檔及各 checkout 的候選版本。整批就緒後，所有派工檔一起出現在 `groups/<組目錄>/coordination/attempt-<N>/assignment.json`。成功時標準輸出的 `assignments` 陣列列出每組派工檔的絕對路徑，可直接用於派工前核對與後續彙整。相同名稱的既有批次或其他程序已取得的目錄會被保留。若程序遭強制中斷而只留下暫存目錄，請使用新的批次目錄名稱重試，只派送成功回傳的檔案。

`--output` 透過同目錄的硬連結發布完整新檔，既有檔案會保留。在不支援硬連結的檔案系統上，省略 `--output` 取得派工 JSON，保存到該組新的 attempt 後執行同一項派工前核對。

## 主代理採納條件

先核對契約版本與派工身分，再核對情境集合、證據、修改權、verification 實際版本與服務版本。共用 Git 儲存庫的 linked worktree 依受測 SHA 與服務版本核對，同一份 feature 的同一情境編號只計一次。不同 repo／版本分開保留。資源釋放狀態另行核對，不因測試通過就認定可重啟或清理。

## Schema 與唯讀彙整

三份自包含 draft 2020-12 Schema： [assignment](../schemas/assignment.schema.json)、[result](../schemas/result.schema.json)、[resource-release](../schemas/resource-release.schema.json)。

彙整需要 Node.js 與 Git。[核准清單 Schema](../schemas/approved-plan.schema.json) 共用派工的情境欄位，`parallel-plan` 與 `parallel-summary` 透過插件內附的驗證器檢查。

```sh
node "<skill 目錄>/scripts/bdd.mjs" parallel-summary --brief --plan "<本輪>/approved-plan.json" --assignment "<A組輸出>/coordination/attempt-1/assignment.json" --assignment "<B組輸出>/coordination/attempt-1/assignment.json" --output-dir "<本輪輸出>/summary-R1"
```

主代理明確列出本輪每組要採用的 attempt。工具讀取核准清單、各組派工檔、同目錄的 result.json 及其引用的驗證和證據。`--output-dir` 必須是尚不存在且與各組輸出互不包含的目錄，避免覆寫。兩種輸出模式均寫入完整的 `summary.json` 與 `SUMMARY.md`。

主代理交接使用 `--brief`，標準輸出是一行 JSON，含 `runId`、`eligibleForReview`、四種狀態的 `counts`、`issueCount` 與指向完整 `summary.json` 的絕對路徑 `summaryPath`。有採納問題時另附 `firstIssue`，依 `summaryPath` 可查全部問題與逐項結果。省略 `--brief` 時標準輸出為完整 JSON。

有採納問題時結束碼為 1。結構與採納檢查通過時為 0，即使有效報告列有失敗或阻塞，仍要核對 `eligibleForReview` 與 `counts`。命令或寫檔錯誤時為 2，原因寫到標準錯誤。

新派工即使省略 `--plan`，彙總也會讀取派工綁定的清單。漏交整組時，摘要點出組名、將缺少的情境列為未執行，並將 `eligibleForReview` 設為 `false`。全部派工都缺少時，可只傳 `--plan` 與 `--output-dir` 產生本輪缺項摘要。歷史 v1 派工可沿用原指令，該模式只能核對所列的派工檔。

歷史彙總可讀取既有 v1、v2 核准清單與當時的紀錄；重新派工使用 v3 清單並送審。v3 批次彙總須一併保留並提供受審的選測檔。

檢查包含 Schema、派工身分、情境缺漏／重複／多出、kind、證據檔存在與路徑隔離、圖片遮罩雜湊紀錄、修改權、驗證輪次的 repo／HEAD／情境／統計、派工與實際服務版本和網址。缺少或不可採納的結果保守列未執行。多版本、重複跨組情境或 dirty 工作區需人工處理，工具不自動採納；重複情境統計去重且留下問題。

eligibleForReview=true 僅表示全部情境回傳通過且上述檢查無問題，供主代理審閱證據，不能直接當作 all pass 或 issue 更新授權。工具無法判斷證據內容是否支持需求、資料庫是否真的安全、依賴是否解除、服務是否仍是受測版本或是否已完成最終整合。resource-release Schema 只驗格式，requestId、停止要求及實際程序釋放仍依[停止確認](#停止確認resource-releasejson)由主代理核對；彙整不宣稱停止確認完成。

獨立整合測試：`node --test "<skill 目錄>/tests/parallel-contracts.test.mjs" "<skill 目錄>/tests/parallel-summary.test.mjs"`。會建立與清除唯一暫存 Git fixture，不操作受測產品或實際服務。
