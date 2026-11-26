# 品質閘門

每組相關變更完成後先執行專案靜態檢查，再閱讀同一份 Diff，檢查錯誤路徑、權限、資料完整性、依賴和回歸。將 findings、嚴重度、檔案行號及風險依據寫入本輪報告。確認工作區沒有漂移後，傳入已核對的基準及 Review 結論。

```powershell
node "<skill 目錄>/scripts/bdd.mjs" quality-plan --repo <工作區> --base <基準> --review-risk MEDIUM --review-reason "<依據>" --static-passed --impact-complete
```

- 只有靜態檢查通過才傳入 `--static-passed`。PR 候選、Release 或明確要求全套／全模組驗證時傳入 `--full`。
- LOW 須確認執行行為不變。第一版只有純文件白名單可走 FAST。MEDIUM 為可界定的局部行為異動。實際改變認證授權、Schema、交易、資料完整性、核心依賴、安全或付款結算時，依系統性風險選 HIGH 並記錄依據。例如調整收據顯示的小數位可只驗證格式與直接使用者；若變更實際扣款金額或結算規則，應提升為 HIGH。本批與哪些情境相依尚未核對時，先以 BLOCKED 補齊映射。
- 核對模組依賴、共用程式、route、endpoint、資料表讀寫及已知失敗紀錄。只有所有受影響模組都已由路徑匹配涵蓋才傳入 `--impact-complete`。如有外溢、映射缺漏或不確定，省略該參數。明確要求範圍以外的必要回歸須列在報告。

### 同一張單的本次回饋

提供 `--issue <單號>` 時，預設採 `--issue-scope batch`。將 `--base` 設為本次回饋修改前的 commit，如上一輪已驗證的版本。批次直接比較指定 commit 的內容與候選工作區，並納入相較基準有差異的暫存變更以及未被 Git 忽略的未追蹤檔。先前受測快照在另一分支時，可直接傳入其 commit；例如本次回饋還原了該快照修改的斷言，仍會選到該情境。

```powershell
node "<skill 目錄>/scripts/bdd.mjs" quality-plan --repo <工作區> --base <回饋前的commit> --issue 5410 --review-reason "核對金額修正及匯出呼叫端" --static-passed --impact-complete --impact-scenario "src/orders/calc.ts=OR-07" --impact-scenario "src/orders/calc.ts=EX-03"
```

- 計畫依編號比對基準版本與目前 Feature 的情境、標籤、步驟及範例列，選出新增或改動的情境。新增 Feature 可選出其中已索引的情境。改動共用前置條件、刪除情境或無法可靠辨識範圍時，檢閱全文，以 `--impact-scenario "異動路徑=現行情境編號"` 列出所有受影響的現行情境。
- 兩批回饋都在同一個未提交工作區時，先對照上一輪保存的快照或差異，確認本批路徑與情境。逐一傳入 `--batch-path "src/orders/calc.ts"` 和本批的 `--impact-scenario`。同一個 Feature 同時有前一批和本批編輯時，將該 Feature 列為 `--batch-path`，再以 `--impact-scenario "<Feature路徑>=本批編號"` 指定每個應測情境。這種方式依人工核對的映射選取，僅接受 Git 確認有變更的路徑，PowerShell 使用 `-BatchPath @(...)`。輸出在 `batchPaths` 列出指定範圍，`allChangedPaths` 保留 Git 可見的全部差異；缺少足以辨識兩批的舊快照時，先確認範圍再派工。
- 程式、設定及其他行為異動，以同一參數逐項連到直接影響及必要回歸。相依情境可來自其他模組；上例只選取計算與匯出這兩個已核對的情境。同單歷史情境、`@core` 或 `@P0` 依本批實際依賴加入映射。輸出的 `batchMappings` 保留人工核對的映射。
- 缺少影響映射、尚未確認外溢範圍或靜態檢查未通過時，`bddStatus` 為 `BLOCKED`，依 `blockers` 補正後重新產生清單。批次預設風險為 MEDIUM。確認高風險時明確傳入 `--review-risk HIGH` 並在 `--review-reason` 說明，或依使用者要求傳入 `--full` 執行完整驗證。PowerShell 對應參數為 `-Issue`、`-IssueScope batch|issue` 及可傳多筆的 `-ImpactScenario`。

### 整單檢查與無單號的模組選測

- 明確需要整單檢查時使用 `--issue <單號> --issue-scope issue`。整單範圍掃描所有模組，納入目前仍存在的本單標籤情境。未改動的模組僅取符合單號的情境。即使本批沒有差異，仍可執行這些歷史情境。TARGETED 在同一受影響模組已有本單 `@#<單號>` 和 `@core` 時選取兩者聯集。缺任一類標籤時保留該模組全部情境。可一併修改已對應模組中仍存在的 Feature，包括 `<portal>/shared/<元件名>` 下的共用模組。共用 BDD 設定、其他模組的 Feature 或刪除 Feature 仍走 FULL。派工前核對實際異動、需補入的回歸、相依情境與刪除後的覆蓋。
- 無單號或使用 `--issue-scope issue` 時，仍可用 `--impact-scenario "src/orders/submit.ts=OR-07"` 提供模組內的來源對應。所有受影響來源皆有映射時，TARGETED 取映射情境、該模組所有 `@core`、`@P0` 與本單情境聯集。模組有未映射來源、當輪修改 Feature 或索引不完整時保留整個模組。以 `scenarioImpact` 核對逐模組選取方式與缺漏。有單號的批次及整單規劃預設為 MEDIUM，無單號維持 HIGH。核對可界定的局部影響後使用 `--review-risk MEDIUM --impact-complete`。
- 計畫的 Feature 雜湊與 Scenario 行號供追溯。派工前核對候選版本及工作區、展開 Background、Outline 和範例列，固定操作、斷言、清理、證據及隔離條件。一次解析並以同一份計畫執行。索引無法完整列舉的檔案會標出 `requiresFullFeature`，例如情境編號後的標題無法辨認時，`unindexedScenarios` 列出行號與編號。映射計畫在 `incompleteFeatures` 列出這些檔案。執行者須核對全文，把索引未能列出的情境與斷言補入派工清單。
- 按 [情境等級與必測範圍](scenario-priority.md) 核對腳本候選清單。TARGETED 補入受影響的 P0、各變更類型必測項及必要回歸。FULL 加列各變更類型所需的技術驗證。
- `PENDING` 是計畫狀態。完成報告使用 PASSED、FAILED、SKIPPED、BLOCKED、TIMEOUT。必要情境缺證據或未完成時閘門不通過。FAST 略過記錄理由。
- 同輪共用已確認的服務、API 連線及唯讀初始化。UI 採 locator 與條件等待，保持 Context 狀態隔離並依證據要求取圖。批次唯讀驗證仍保留逐項斷言。遵守既有資料庫授權與並行資源契約。
- 同輪可重用解析結果及版本一致的步驟。Git 比對結果只供追溯。即時 UI、API、DB 及 HIGH 或 FULL 需要當輪證據。
- 每輪記錄 Diff 摘要、風險與 findings、選取和略過理由、各情境狀態與證據、耗時、各工具呼叫數及 Token。資料不可取得時記為未知。分開呈現同集執行效率與選擇縮減比例，記錄剩餘風險及合併建議。

## 隔離同集基準

目前以 Node.js 22.13 以上（內建 `node:sqlite`）、已安裝的 `@playwright/cli` 及瀏覽器執行
`node skills/bdd-local-test/tests/Test-QualityBenchmark.mjs`。測試以隔離瀏覽器、
loopback HTTP 服務及臨時 SQLite 讀取同一筆訂單，分開呼叫及批次呼叫各跑三輪。

2026-11-25 在 Windows 以 Node.js 24.22.1、Playwright CLI 0.1.25 與 Chrome 實測。兩種策略各三輪，每輪六項斷言皆通過。分開呼叫每輪五次，中位數 11,538 ms；批次每輪三次，中位數 7,464 ms。兩者皆計入 `open` 與 `close`。另以錯誤的 UI 預期值執行批次測試，回報 `FAILED` 並以狀態碼 1 結束。

## Claude Code Hook 驗證

變更技能的批次操作指引後，可從插件 repo 根目錄執行下列命令。測試需要已登入的 Claude Code CLI 與上述基準測試環境。`UserPromptSubmit` Hook 會載入目前工作區的技能，讓代理選擇操作方式，並回傳該輪的斷言結果、耗時及 Token 用量。

```powershell
pwsh -NoProfile -File skills/bdd-local-test/tests/Test-QualityAgent.ps1 -Version candidate
```

加上 `-InjectFailure` 可確認代理在錯誤預期下只執行一次，並回報 `FAILED`。
