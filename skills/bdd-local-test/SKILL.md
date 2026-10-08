---
name: bdd-local-test
description: 用於 BDD、Gherkin、驗收情境、feature 檔、本機測試、Playwright MCP 測 localhost、失敗就修或測到全部通過；將功能異動寫成繁體中文情境，以真實 UI／API／資料庫路徑驗證，也處理 cherry-pick、merge 或跨 repo 同步後的複測。
---

# BDD 情境與本機驗證

將需求寫成可判定的情境，實際執行並保存證據。產品缺陷要修正、重啟受影響服務並複測；無法解除的阻塞如實回報。情境存於 `.bdd/modules/<portal>/<主路由>/`；每輪的 `REPORT.md`、`verification.json` 與證據存於 `.bdd/<單號>-<主題>/`。使用者指定其他範圍或只要情境／報告時，依其要求縮小流程。

## 共同規則

- 先讀目標專案的 `AGENTS.md`／`CLAUDE.md`／README、環境設定及 `.bdd/config.json`。本 skill 不預設埠號、帳號、基準分支或資料庫。下文的 `<skill 目錄>` 是此檔所在資料夾。
- 「那麼」以需求為準，不照抄錯誤實作；發現不符時標 `@已知缺陷`，實測讓它失敗。只有走真實路徑驗到的結果才能記「通過」；模擬回應、假 token 或旁證不能代替端對端驗證。
- 報告只對記錄的 repo、commit 與工作區狀態有效。同步或受測檔案變更時先用 `bdd-verification.ps1 -Check` 判定；`rerun` 要完整重跑。
- 執行可能寫入資料前，確認連到本機或使用者已確認的測試環境；SIT／UAT／PROD 或無法判定時停止寫入並詢問。缺帳密時不得繞過驗證，相關情境列「阻塞」。
- 情境新增或修改後先跑 `bdd-modules.ps1 -Lint`，再按 [情境審核](references/scenario-review.md) 做獨立審核。子代理只讀原始需求與程式，不修改檔案；審核問題逐條處理。
- 截圖當下遮蓋個資並登記；未遮罩的證據不得上傳或封存。全通過表示失敗、阻塞、未執行皆為 0，且每個情境都經真實路徑驗證。
- BDD 全通過後要更新 issue 時，先依當下 issue、repo、commit 範圍與可用 skill 動態選擇唯讀一致性審核 skill；Redmine 且需要需求／程式雙向比對時優先選 `issue-code-consistency-check`。派子代理審核結果只有 `PASS` 才能寫入 issue，其他結果一律阻擋並回報。Redmine 註記逐項使用「修正項目 N」後緊接「圖片 N」，純 API／DB 情境改附替代證據。
- 用檔案編輯工具寫 `.feature` 與 `REPORT.md`；內容常含引號與反引號，避免用會被 shell 解析的 heredoc。

## 按階段讀取

1. **確定範圍、版本與情境**：讀 [範圍、版本比對與情境撰寫](references/workflow-and-scenarios.md)。寫 `.feature` 前讀 [情境寫法](references/feature-guide.md)；使用模組時讀 [模組情境集](references/modules.md)。情境寫完後讀 [情境審核](references/scenario-review.md)。使用者只要情境時，在審核與未執行報告完成後停止。
2. **本機實測與修正**：需要執行時讀 [本機執行與複測](references/local-execution.md) 及 [報告與驗證紀錄](references/reporting.md)；worktree 另讀 [loopback 隔離](references/worktree-loopback.md)。逐情境保留證據，每輪先記錄結果與版本；失敗後修正、重啟並重測。
3. **報告**：需要報告時讀 [報告與驗證紀錄](references/reporting.md) 和 [報告範本](assets/REPORT-template.md)。使用者只要測試報告時不整合或更新 issue；若需封存，再讀下階段的封存步驟。
4. **全通過後收尾**：讀 [整合與封存](references/closeout.md)，先詢問「合併回 develop／轉為正式 feature 分支／只保留測試報告」；本輪已指定時沿用。合併模式完成 `develop` 複測、issue 更新與封存；feature 模式確認名稱並轉換分支、保留工作區。未回答前不合併或刪除證據／worktree；服務停止獨立依收尾指引的共用條件判定，不等待模式選擇或封存。遮罩、封存或清理時再讀 [封存指引](references/archive.md)。

各階段只讀當前需要的參考文件，不把整套參考文件一次載入。腳本的參數、輸出與錯誤處理以對應階段文件為準。
