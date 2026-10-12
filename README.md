# BDD Skills

提供 Claude Code 與 Codex 使用的繁體中文 BDD 測試插件，協助團隊把需求整理成可判定的 Gherkin 驗收情境，透過真實的 UI、API 與資料庫路徑在本機驗證，並保留可追溯的測試報告與證據。

## 插件介紹

`bdd-skills` 目前提供 `bdd-local-test` skill，適合需要將功能異動轉成驗收情境、執行本機測試、處理失敗後修正並重新驗證的專案。它整合繁體中文情境撰寫、Playwright 或 Node Playwright 本機執行、測試證據保存、模組化情境維護，以及 BDD 結果整理與封存流程。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。
- `tests/`：封存、遮罩與清理腳本的 Pester 測試（`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests"`）。

執行本機 UI 情境時，skill 會優先用已連線的 Playwright MCP 開啟 localhost；發現產品缺陷會修正、重啟並複測。Playwright MCP 未連線或 worktree 需要獨立瀏覽器參數時，改用 Node Playwright，並在報告說明。情境照功能模組持續維護在 `.bdd/modules/`，每張單只留本輪結果與證據（見 `skills/bdd-local-test/references/modules.md`）；封存時截圖轉成無損 WebP，約省一半空間。情境寫完會先交給子代理獨立審核（需求對應、預期是否照抄程式、覆蓋缺漏），處理完必修項目才執行，審核方式見 `skills/bdd-local-test/references/scenario-review.md`。截圖當下就遮蓋個資並登記。準備正式完整驗證前，先確認收尾模式：合併回 develop、轉為正式 feature 分支，或只保留測試報告；本輪已指定時沿用，未回答前保留工作區；服務停止獨立依收尾指引判定，BDD 全通過且 issue 註記與必要證據更新完成後自動停止本輪 worktree 服務，不等待模式選擇或封存。feature 模式確認分支名稱後轉換並保留工作區與證據。選擇合併模式時，開發中只測修正與相關回歸，完整驗證集中在最新 `develop` 整合後、推送前一次；同版本推送後只核對 SHA、更新對應 issue 並附修正後截圖；再將完整 BDD 輸出去重封存到本機封存庫（預設 `~/bdd-archives/<repo>/`，不會落在任何 worktree 內），上傳 issue 並登記索引後，清理工作區證據與本輪 worktree。衝突、權限或驗證問題會如實回報。封存細節見 `skills/bdd-local-test/references/archive.md`。

## BDD 版控分工

Git 僅保存 `.bdd/modules/` 的情境與 `MODULE.md`、不含敏感或個人設定的 `.bdd/config.json`。每輪 `.bdd/<單號>-<主題>/` 的報告、驗證與遮罩紀錄、截圖、log 和瀏覽器 profile 均不新增到 Git，由本機輸出及完整封存包保存；收尾不另建純報告提交。維持既有輸出路徑，忽略規則、既有追蹤資料遷移與跨工作區還原見 [版控分工](skills/bdd-local-test/references/version-control.md)。

## 安裝到 Claude Code

Claude Code 2.1.275 以上可在互動工作階段輸入一條指令，加入此 marketplace 並安裝 plugin：

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

首次加入 marketplace 時依提示確認，並選擇安裝範圍。安裝後的技能指令是 `/bdd-skills:bdd-local-test`。

已安裝者可在終端機更新 marketplace 與 plugin；更新後重啟 Claude Code 以載入新版本：

```text
claude plugin marketplace update zokmi-bdd-skills
claude plugin update bdd-skills@zokmi-bdd-skills
```

## 安裝到 Codex

在終端機執行：

```text
codex plugin marketplace add zokmi/bdd-skills
codex plugin add bdd-skills@zokmi-bdd-skills
```

安裝後可在 Codex 使用 `bdd-local-test` skill。

實際執行測試前，請先閱讀目標專案的指引與環境設定，並依 `SKILL.md` 的安全確認流程操作。
