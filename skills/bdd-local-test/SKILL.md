---
name: bdd-local-test
description: 用於 BDD、Gherkin、驗收情境、feature 檔、本機測試、Playwright MCP 測 localhost、失敗就修或測到全部通過；每輪實測自動評估子代理分組驗證，以真實 UI／API／資料庫路徑驗證，也處理 cherry-pick、merge 或跨 repo 同步後的複測。
---

# BDD 情境與本機驗證

將需求寫成可判定的情境，實際執行並保存證據。產品缺陷要修正、重啟受影響服務並複測；無法解除的阻塞如實回報。情境存於 `.bdd/modules/<portal>/<主路由>/`；每輪的 `REPORT.md`、`verification.json` 與證據存於 `.bdd/<單號>-<主題>/`。使用者指定其他範圍或只要情境／報告時，依其要求縮小流程。

## 共同規則

- **多專案／worktree 的臨時埠**：確認各服務原始 URL、設定來源與啟動命令。原埠在本輪隔離 IP 被占用時，自動分配臨時有效埠。依 [worktree 隔離](references/worktree-loopback.md) 使用本輪啟動參數或程序環境覆寫，核對 UI、API、proxy／SSR 的實際目標與版本，再開始測試。維持專案設定檔、系統 hosts 與全域代理原狀。

- 先讀目標專案的 `AGENTS.md`／`CLAUDE.md`／README、環境設定及 `.bdd/config.json`。本 skill 不預設埠號、帳號、基準分支或資料庫。下文的 `<skill 目錄>` 是此檔所在資料夾。
- 依 [版控分工](references/version-control.md)，Git 只保存模組情境、`MODULE.md` 與共用設定；每輪報告、驗證與遮罩紀錄及證據保存在本機輸出與完整封存，不新增到 Git、不另建純報告提交。既有追蹤輸出先驗證封存，再依明確授權遷移。
- 「那麼」以需求為準，不照抄錯誤實作；發現不符時標 `@已知缺陷`，實測讓它失敗。只有走真實路徑驗到的結果才能記「通過」；模擬回應、假 token 或旁證不能代替端對端驗證。
- BDD 的 `@UI` 情境必須使用 Playwright MCP 操作與取證，不得改用 Node Playwright、CLI 或其他瀏覽器工具替代。MCP 無法連線或無法滿足隔離時先排查；仍無法執行則列「阻塞」。共用 MCP session 的 UI 情境序列執行；純 `@API`／`@DB` 情境維持各自的真實驗證工具。
- 報告只對記錄的 repo、commit 與工作區狀態有效。同步或受測檔案變更時先用 `bdd-verification.ps1 -Check` 判定；`rerun` 代表舊結果失效，完整重跑的時機依下節驗證階段決定，不在合併前後各跑一輪。
- **資料庫環境確認是實測前的必要關卡**：依 [執行前的安全確認](references/local-execution.md) 展示實際資料庫主機／執行個體、庫名、環境、設定來源及讀寫範圍，收到使用者針對該目標的明確確認後，才可開始 UI／API／DB 實測、啟動可能連庫寫入的服務或派實測子代理。本機與唯讀情境同樣須確認；只告知、已提問、沉默或「測到全過」不算確認。同任務目標與授權範圍未變的複測沿用既有明確確認；目標或範圍改變時重新確認。缺帳密不得繞過驗證，相關情境列「阻塞」。
- 情境新增或修改後先跑 `bdd-modules.ps1 -Lint`，再按 [情境審核](references/scenario-review.md) 做獨立審核。情境審核子代理只讀原始需求與程式，不修改檔案；審核問題逐條處理。
- 每輪實測前依下節判定執行模式；可拆成至少兩組安全獨立執行的情境且有可用子代理時，自動派實測子代理，不等待使用者說「並行」。情境審核、實測派工與 issue 前一致性審核是三個不同步驟，完成其中一項不代表完成其他項。
- 截圖當下遮蓋個資並登記；未遮罩的證據不得上傳或封存。全通過表示失敗、阻塞、未執行皆為 0，且每個情境都經真實路徑驗證。
- 整合封存與 worktree 清理前，完成已授權的 issue 交付並回讀核對；未完成時保留原始證據與 worktree。依 [整合與封存](references/closeout.md) 執行。
- 指定 issue 的最終完整驗證全通過後，依 [共用 issue 交付](references/closeout.md#共用-issue-交付最終完整驗證後自動執行) 自動接續一致性審核、模板、證據上傳與回讀核對。
- 用檔案編輯工具寫 `.feature` 與 `REPORT.md`；內容常含引號與反引號，避免用會被 shell 解析的 heredoc。

## 修改完成時的驗證入口

以一組相關修改為單位固定基準與候選版本，執行靜態檢查並 Review Diff，再按 [品質閘門](references/quality-gate.md) 選擇 FAST、TARGETED 或 FULL。只有確認不影響行為的純文件改動可走 FAST。局部行為改動選 TARGETED。高風險、PR、Release 或影響不明選 FULL。

同一 UI 情境中，將相容的導航與 locator 檢查批次交給 Playwright MCP，逐項保留斷言與失敗位置。跨情境維持狀態隔離。

需要實測、撰寫情境或收尾時，依 [分階段工作流程](references/execution-workflow.md) 讀取對應指引。開始實測前先核對驗證時機與資料庫授權，再選擇派工模式。FAST 符合略過條件時，直接記錄理由及靜態檢查結果。
