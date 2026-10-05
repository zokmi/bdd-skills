# BDD Skills

Claude Code 與 Codex 跨專案 BDD 測試 skill。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。
- `tests/`：封存、遮罩與清理腳本的 Pester 測試（`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests"`）。

執行本機 UI 情境時，skill 會優先用已連線的 Playwright MCP 開啟 localhost；發現產品缺陷會修正、重啟並複測。Playwright MCP 未連線或 worktree 需要獨立瀏覽器參數時，改用 Node Playwright，並在報告說明。情境照功能模組持續維護在 `.bdd/modules/`，每張單只留本輪結果與證據（見 `skills/bdd-local-test/references/modules.md`）；封存時截圖轉成無損 WebP，約省一半空間。情境寫完會先交給子代理獨立審核（需求對應、預期是否照抄程式、覆蓋缺漏），處理完必修項目才執行，審核方式見 `skills/bdd-local-test/references/scenario-review.md`。截圖當下就遮蓋個資並登記。所有情境經真實路徑驗證通過後，先詢問收尾模式：合併回 develop、轉為正式 feature 分支，或只保留測試報告；本輪已指定時沿用，未回答前保留工作區。feature 模式確認分支名稱後轉換並保留工作區與證據。選擇合併模式才會合併並複測 `develop`、更新對應 issue 並附修正後截圖；再將完整 BDD 輸出去重封存到本機封存庫（預設 `~/bdd-archives/<repo>/`，不會落在任何 worktree 內），上傳 issue 並登記索引後，清理工作區證據與本輪 worktree。衝突、權限或驗證問題會如實回報。封存細節見 `skills/bdd-local-test/references/archive.md`。

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

## 發布 GitHub Release

發版時先將 `plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 的 `version` 一起更新為相同的 `MAJOR.MINOR.PATCH`，並將變更合併到 `main`。接著從該提交建立並推送對應的 tag：

```sh
git checkout main
git pull --ff-only
git tag v1.3.1
git push origin v1.3.1
```

推送 `vMAJOR.MINOR.PATCH` tag 會觸發 [Release workflow](.github/workflows/release.yml)。它會確認 tag 所指提交位於 `main`、三份版本資訊與 tag 一致，並在 Pester 測試通過後建立 GitHub Release 與自動產生發行說明。檢查失敗時不會發布 Release。上方 `v1.3.1` 只是指令範例，請換成實際要發布的版本。
