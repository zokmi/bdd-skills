---
name: bdd-local-test
description: 用於撰寫或審核 BDD／Gherkin／feature 驗收情境、維護模組業務行為規格、本機 UI／API／DB 驗證、Playwright CLI 測 localhost、失敗修正與複測，以及 cherry-pick／merge／跨 repo 同步後的結果有效性確認。適用互動畫面、外部系統 API 與事件／排程觸發的業務流程。
---

# BDD 情境與本機驗證

本 skill 維護模組對使用者或外部角色承諾的可觀察業務行為，並協調本機驗證。將業務需求寫成可判定的成功與異常情境，工程調整依風險另列技術驗證；兩者都保存可追溯的結果與證據。產品缺陷要修正、重啟受影響服務並複測；無法解除的阻塞如實回報。情境存於 `.bdd/modules/<portal>/<主路由>/`；每輪的 `REPORT.md`、`verification.json` 與必要交付證據存於 `.bdd/<單號>-<主題>/`。使用者指定其他範圍或只要情境／報告時，依其要求縮小流程。

實測優先使用內建 localhost 轉送、API 與選配 SQL Server 工具。從受測 worktree 的 `.bdd/config.json` 取得設定，僅在工具缺少情境能力時新增本輪腳本。參閱[內建實測工具](references/test-kit.md)。

## 共同規則

- **情境範圍**：BDD 文件描述模組對使用者或外部角色承諾的可觀察業務行為，以角色、前置條件、操作或觸發事件、成功與異常結果為主。外部系統 API、事件與排程的業務流程同樣適用，不限畫面操作。純重構、部署設定、SQL migration、工具與文件調整等工程項目，依風險列入驗證清單與報告，不逐項轉成 `.feature`。`@UI`／`@API`／`@DB` 是驗證手段，情境範圍依業務承諾判定；詳細界線見 [情境寫法](references/feature-guide.md)。

- **多專案／worktree 的臨時埠**：確認各服務原始 URL、設定來源與啟動命令。原埠可用時沿用；原埠在本輪隔離 IP 被占用時，由 `node bdd.mjs prepare-worktree-cli` 自動分配臨時有效埠，不自行猜埠。啟動、轉送、測試及清理使用同一份 `portMappings`。使用者要求固定原埠時使用 `--keep-original-ports`，無法安全使用原埠則列阻塞，不以換埠掩蓋跨 repo 的 IP／registry 衝突。依 [worktree 隔離](references/worktree-loopback.md) 使用本輪啟動參數或程序環境覆寫。以本輪具名 Playwright CLI session 通過 localhost 路由探測後，才開啟應用頁面，並核對 UI、API、proxy／SSR 的實際目標與版本。維持專案設定檔、系統 hosts 與全域代理原狀。

- 先讀目標專案的 `AGENTS.md`／`CLAUDE.md`／README、環境設定及 `.bdd/config.json`。本 skill 不預設埠號、帳號、基準分支或資料庫。下文的 `<skill 目錄>` 是此檔所在資料夾。
- 依 [版控分工](references/version-control.md)，Git 只保存模組情境、`MODULE.md` 與共用設定；報告、驗證與遮罩紀錄保存在本機，依審核通過的清單保存截圖，不新增到 Git、不另建純報告提交。既有追蹤輸出先核對非圖片紀錄及 Redmine 附件，再依明確授權遷移。
- 「那麼」以需求為準，不照抄錯誤實作；發現不符時標 `@已知缺陷`，實測讓它失敗。只有走真實路徑驗到的結果才能記「通過」；模擬回應、假 token 或旁證不能代替端對端驗證。
- BDD 的 `@UI` 情境以 Microsoft Playwright CLI 操作與取證。每組從受測工作區以唯一 session 名稱執行 `playwright-cli -s=<名稱>` 的各項命令。共用 session 的 UI 操作序列執行。CLI、瀏覽器或路由隔離無法就緒時，排查後將受影響的 UI 情境列「阻塞」。`@API`／`@DB` 情境使用各自的真實驗證工具。
- 報告只對記錄的 repo、commit 與工作區狀態有效。同步或受測檔案變更時先用 `node bdd.mjs verification --check` 判定；`rerun` 代表舊結果失效，完整重跑的時機依下節驗證階段決定，不在合併前後各跑一輪。
- **資料庫環境確認是實測前的必要關卡**：依 [執行前的安全確認](references/local-execution.md) 展示實際資料庫主機／執行個體、庫名、環境、設定來源及讀寫範圍，收到使用者針對該目標的明確確認後，才可開始 UI／API／DB 實測、啟動可能連庫寫入的服務或派實測子代理。本機與唯讀情境同樣須確認；只告知、已提問、沉默或「測到全過」不算確認。同任務目標與授權範圍未變的複測沿用既有明確確認；目標或範圍改變時重新確認。缺帳密不得繞過驗證，相關情境列「阻塞」。
- **情境文件異動自動檢查**：新增、修改、刪除、改名或整併 `.feature`，以及修改影響情境歸屬／規則的 `MODULE.md` 後，自動依 [bdd-scenario-audit](../bdd-scenario-audit/SKILL.md) 派未參與撰寫的唯讀子代理檢查，不另問是否執行。先跑 `node bdd.mjs modules --lint`；與下述獨立審核可合併派工並分別記錄結論。必修修正後複審，無子代理時記阻塞，不以自行檢查代替獨立通過。
- 依 [情境審核](references/scenario-review.md) 先派子代理選取本輪 BDD 情境範圍，再派子代理產出預計驗證項目清單。把清單與情境一併交獨立唯讀子代理審核，文件合規與情境審核通過後才派工或開始實測。
- 每輪實際 BDD 測試都必須由實測子代理執行，主代理負責範圍審核、分組、派工、監督與彙整；至少一組也派一名子代理，兩組以上依資源可用情況分批派工。不可用主代理親自執行實測作為一般 fallback。開始實測與派工前，先依 [實測範圍審核](references/execution-workflow.md#實測範圍審核) 取得未參與執行的獨立唯讀子代理 PASS。情境只撰寫或整理既有報告而不實測時不派實測子代理。若平台確實沒有子代理派工能力，停止實測並記錄阻塞，不可改由主代理測試或假稱已派工。
- **並行準備服務與測資**：實測範圍審核 PASS 且環境確認完成後，當前批次同時需要準備服務與建立測資且有兩個名額時，同批派兩名子代理分別負責。測資代理先做不依賴服務的工作，依賴本輪服務的項目收到就緒資訊後再操作。各情境在所需服務與測資就緒後開始實測。只有一名子代理時依相依順序完成，詳見[分工與交接](references/parallel-bdd.md#並行準備服務與測資)。
- 依審核通過的清單擷取並遮罩登記情境截圖，保存在本輪 `evidence/` 並於報告連結。issue 交付只取最終驗證輪所需的圖，回讀確認附件可讀且回覆內容審核通過後清除該交付副本。代理驗證時為查看畫面而暫存的其他截圖，讀取結果並記下必要的文字斷言後立即刪除，不放入持久 evidence、報告圖片連結或封存。全通過表示失敗、阻塞、未執行皆為 0，且每個情境都經真實路徑驗證。
- issue 必要截圖與 worktree 清理依 [整合與交付](references/closeout.md) 執行；其他代理即時驗證截圖判讀後立即刪除，不因 issue 交付未完成而保留。
- 每輪實測先驗證核心異動及其必要前置。依需求、實際 diff 和斷言辨認核心異動；有指定 issue 時，先跑本單的核心異動，再跑本單其餘驗收項目。無單號也依實際變更優先驗證核心異動。
- 主代理從派工起[持續追蹤驗證進度](references/parallel-bdd.md#回報與收尾)。本單驗收或最終完整驗證的項目全數 PASS 且證據齊備時，自動派獨立子代理審核結果報告。指定 issue 且已授權回寫時，依 [Issue 優先驗證與回寫](references/execution-workflow.md#issue-優先驗證與回寫) 或[最終交付條件](references/closeout.md#共用-issue-交付最終完整驗證後自動執行)接續一致性審核。兩項審核均 PASS 後，直接派專責子代理更新 issue 並回讀核對。
- 每次回寫後，自動交給未參與撰寫或寫入的唯讀子代理，依 [Issue 回覆內容審核](../bdd-issue-reply-audit/SKILL.md) 比對線上回覆、實際調整與驗證證據。取得 PASS 後才依[收尾指引](references/closeout.md)判定是否停止本輪服務，並於分支方式未定時詢問。回覆需要更正時，修正後重新回讀、送審。
- 用檔案編輯工具寫 `.feature` 與 `REPORT.md`；內容常含引號與反引號，避免用會被 shell 解析的 heredoc。

## 修改完成時的驗證入口

以一組相關修改為單位固定基準與候選版本，執行靜態檢查並 Review Diff，再按 [品質閘門](references/quality-gate.md) 選擇 FAST、TARGETED 或 FULL。只有確認不影響行為的純文件改動可走 FAST。局部行為改動選 TARGETED。高風險、PR、Release 或影響不明選 FULL。

依 [情境等級與必測範圍](references/scenario-priority.md) 為新增與實質修改的情境標 `@P0`／`@P1`／`@P2`，並依變更類型核對驗收條件、必測情境與技術驗證。小 issue 走 TARGETED 時，以受影響模組的 `@core`、本單 `@#<單號>` 為候選，補入受影響的 P0、變更類型必測項及必要回歸。最終候選版本也按同一規則核對。報告列出實測情境與略過理由。

同一 UI 情境中，可用同一個 Playwright CLI session 的 `run-code` 批次執行相容的導航與 locator 檢查，逐項保留斷言與失敗位置。跨情境維持狀態隔離。

通過環境確認後，需要登入的情境依 [登入自動化](references/authentication.md) 準備前置狀態：優先沿用已驗證的同環境、同帳號狀態，失效時執行專案提供的測試登入流程。

需要實測、撰寫情境或收尾時，依 [分階段工作流程](references/execution-workflow.md) 讀取對應指引。開始實測前先核對驗證時機與資料庫授權，再選擇派工模式。FAST 符合略過條件時，直接記錄理由及靜態檢查結果。
