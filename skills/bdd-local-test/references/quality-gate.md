# 品質閘門

每組相關變更完成後先執行專案靜態檢查，再閱讀同一份 Diff，檢查錯誤路徑、權限、資料完整性、依賴和回歸。將 findings、嚴重度、檔案行號及風險依據寫入本輪報告。確認工作區沒有漂移後，傳入已核對的基準及 Review 結論。

```powershell
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-quality-plan.ps1" -Repo <工作區> -Base <基準> -ReviewRisk MEDIUM -ReviewReason "<依據>" -StaticPassed -ImpactComplete
```

- 只有靜態檢查通過才傳入 `-StaticPassed`。PR 候選、Release 或明確要求全套／全模組驗證時傳入 `-Full`。
- LOW 須確認執行行為不變。第一版只有純文件白名單可走 FAST。MEDIUM 為可界定的局部行為異動。認證授權、Schema、交易、資料完整性、核心依賴、安全、付款及不明影響一律 HIGH。
- 核對模組依賴、共用程式、route、endpoint、資料表讀寫及已知失敗紀錄。只有所有受影響模組都已由路徑匹配涵蓋才傳入 `-ImpactComplete`。如有外溢、映射缺漏或不確定，省略該參數。明確要求範圍以外的必要回歸須列在報告。
- 小 issue 可加 `-Issue <數字單號>`。TARGETED 在同一受影響模組已有本單 `@#<單號>` 和 `@core` 時選取兩者聯集。缺任一類標籤時保留該模組全部情境。可一併修改已對應模組中仍存在的 Feature；共用 BDD 設定、其他模組的 Feature 或刪除 Feature 仍走 FULL。派工前用 diff 與需求核對清單，補入所有本輪新增或修改的情境，以及未加標籤的必要回歸和依賴情境。情境有刪除時，核對原斷言仍有必要覆蓋。若無法確認清單涵蓋全部影響，改用 FULL。FULL 執行所有模組情境，`-Issue` 不縮減其範圍。
- 計畫的 Feature 雜湊與 Scenario 行號供追溯。派工前核對候選版本及工作區、展開 Background、Outline 和範例列，固定操作、斷言、清理、證據及隔離條件。一次解析並以同一份計畫執行。索引列舉若無法完整描述 Feature，以原始 Feature 全檔為執行範圍。
- `PENDING` 是計畫狀態。完成報告使用 PASSED、FAILED、SKIPPED、BLOCKED、TIMEOUT。必要情境缺證據或未完成時閘門不通過。FAST 略過記錄理由。
- 同輪共用已確認的服務、API 連線及唯讀初始化。UI 採 locator 與條件等待，保持 Context 狀態隔離並依證據要求取圖。批次唯讀驗證仍保留逐項斷言。遵守既有資料庫授權與並行資源契約。
- 同輪可重用解析結果及版本一致的步驟。Git 比對結果只供追溯。即時 UI、API、DB 及 HIGH 或 FULL 需要當輪證據。
- 每輪記錄 Diff 摘要、風險與 findings、選取和略過理由、各情境狀態與證據、耗時、各工具呼叫數及 Token。資料不可取得時記為未知。分開呈現同集執行效率與選擇縮減比例，記錄剩餘風險及合併建議。

## 隔離同集基準

在已預先安裝 Playwright MCP 0.0.84 的 Windows 環境執行
`node skills/bdd-local-test/tests/Test-QualityBenchmark.cjs`。測試以隔離瀏覽器、
loopback HTTP 服務及臨時 SQLite 讀取同一筆訂單，分開呼叫及批次呼叫各跑三輪。

2026-11-03 實測六輪均通過。分開呼叫耗時 2959、2945、2826 ms，
批次呼叫耗時 2328、2531、2152 ms。中位數由 2945 降至 2328 ms（20.95%）。
每輪 Playwright MCP 呼叫（含關閉瀏覽器）由 4 降至 2。每輪均執行
UI 標題和狀態、API HTTP 狀態與 JSON 內容類型和欄位、DB 唯讀查詢。
API 與 DB 各執行一次。計時不含服務與 MCP 初始化。
此基準由確定性腳本驅動，沒有模型 Token 遙測。
量測範圍為同集呼叫策略，完整 Skill 的 Agent 與 Hook 尚需另行驗收。

## Claude Hook 同集驗收

驗收用 UserPromptSubmit Hook 載入指定版本的 Skill，由 Agent 依 Skill
選擇分步或批次。每版三輪，所有六項 fixture 斷言均通過，且沒有工具權限拒絕。
候選版另以錯誤 UI 預期值注入故障，回傳 FAILED，測試腳本以非零結束碼停止。

| 指標（中位數） | 1.5.12 | 候選版 |
| --- | ---: | ---: |
| Agent 耗時（ms） | 18692 | 15252 |
| Fixture 耗時（ms） | 2745 | 2103 |
| MCP 呼叫數 | 4 | 2 |
| 一般輸入 Token | 6 | 6 |
| 輸出 Token | 425 | 413 |
| 快取寫入 Token | 8901 | 9167 |
| 快取讀取 Token | 91194 | 91444 |

Fixture 耗時降低 23.39%，Agent 耗時降低 18.40%，輸出 Token 降低
2.82%。端到端耗時及 Token 尚未達 20% 目標。此 Hook 用於驗收，
產品端任務完成 Hook 另需整合驗證。

## 專案 Hook 發布驗收

Claude Code 由隔離專案的 .claude/settings.json 載入驗收 Hook。
固定策略比較與自主策略驗收各版本各三輪，十二輪均通過同一組六項斷言。
兩組均注入錯誤 UI 預期值並驗證 FAILED。候選版自主故障首測重跑，
強化故障輪指示後重測，只執行一次並回報 FAILED。

| 固定策略中位數 | 1.5.12 | 1.5.13 |
| --- | ---: | ---: |
| Agent 耗時（ms） | 20001 | 17524 |
| Fixture 耗時（ms） | 2950 | 2029 |
| MCP 呼叫 | 4 | 2 |
| Token 合計 | 98973 | 63927 |

Token 合計按輪加總一般輸入、輸出、快取讀取與快取寫入，再取中位數。
固定策略 Agent 耗時降低 12.38%，Token 約降低 35.4%。
自主策略用於核對選擇及覆蓋，候選版三輪均選批次。
