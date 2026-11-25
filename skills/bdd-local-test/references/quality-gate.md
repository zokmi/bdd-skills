# 品質閘門

每組相關變更完成後先執行專案靜態檢查，再閱讀同一份 Diff，檢查錯誤路徑、權限、資料完整性、依賴和回歸。將 findings、嚴重度、檔案行號及風險依據寫入本輪報告。確認工作區沒有漂移後，傳入已核對的基準及 Review 結論。

```powershell
node "<skill 目錄>/scripts/bdd.mjs" quality-plan --repo <工作區> --base <基準> --review-risk MEDIUM --review-reason "<依據>" --static-passed --impact-complete
```

- 只有靜態檢查通過才傳入 `--static-passed`。PR 候選、Release 或明確要求全套／全模組驗證時傳入 `--full`。
- LOW 須確認執行行為不變。第一版只有純文件白名單可走 FAST。MEDIUM 為可界定的局部行為異動。認證授權、Schema、交易、資料完整性、核心依賴、安全、付款及不明影響一律 HIGH。
- 核對模組依賴、共用程式、route、endpoint、資料表讀寫及已知失敗紀錄。只有所有受影響模組都已由路徑匹配涵蓋才傳入 `--impact-complete`。如有外溢、映射缺漏或不確定，省略該參數。明確要求範圍以外的必要回歸須列在報告。
- 小 issue 可加 `--issue <數字單號>`。TARGETED 在同一受影響模組已有本單 `@#<單號>` 和 `@core` 時選取兩者聯集。缺任一類標籤時保留該模組全部情境。可一併修改已對應模組中仍存在的 Feature；共用 BDD 設定、其他模組的 Feature 或刪除 Feature 仍走 FULL。派工前用 diff 與需求核對清單，補入所有本輪新增或修改的情境，以及未加標籤的必要回歸和依賴情境。情境有刪除時，核對原斷言仍有必要覆蓋。若無法確認清單涵蓋全部影響，改用 FULL。FULL 執行所有模組情境，`--issue` 不縮減其範圍。
- 局部修正已能從檔案、端點及其呼叫端追到具體情境時，可在上述命令加上可重複的 `--impact-scenario "src/orders/submit.ts=OR-07"`。PowerShell 包裝入口使用 `-ImpactScenario @('src/orders/submit.ts=OR-07','src/orders/submit.ts=OR-11')`。左側填 Git 差異中的確切程式路徑，右側填該路徑對應模組內的情境編號。同一檔案或端點影響多個規則、共用呼叫端或模組時，逐一列入對應並以 `--review-reason` 記下檢閱依據。先核對原始需求、實際 diff 與依賴，確定完整後才提供 `--impact-complete`。無法辨識正確來源或情境編號的對應會報錯。
- 提供映射後，TARGETED 逐模組核對來源。所有受影響來源都有對應時，取映射情境、該模組所有 `@core`、`@P0` 和本單情境聯集，無單號也可使用。檔案映射不足以判定其他 P0 與變更無關，因此採保守聯集。模組缺任一路徑對應或索引無法列舉時，保留該模組全部情境。當輪一併修改有明確映射模組內現存的 Feature 時，即使沒有單號也可保留該模組全部情境。刪除 Feature、修改無關模組 Feature 或共用設定仍採 FULL。核對輸出 `scenarioImpact` 的逐模組選取方式、來源對應、未映射路徑與異動 Feature；驗收條件或舊版無等級情境涉及的必要回歸仍由範圍審核補足。未傳映射時沿用上述單號選取規則。高風險、影響未確定、要求完整驗證及 lint 阻塞等條件維持原規則。
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
