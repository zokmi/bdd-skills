# BDD Skills

Claude Code 與 Codex 跨專案 BDD 測試 skill。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。

執行本機 UI 情境時，skill 會優先用已連線的 Playwright MCP 開啟 localhost；發現產品缺陷會修正、重啟並複測。Playwright MCP 未連線或 worktree 需要獨立瀏覽器參數時，改用 Node Playwright，並在報告說明。只有所有情境經真實路徑驗證通過，才會標示 all pass。

## 安裝到 Claude Code

Claude Code 2.1.275 以上可在互動工作階段輸入一條指令，加入此私人 marketplace 並安裝 plugin：

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

首次加入 marketplace 時依提示確認，並選擇安裝範圍。安裝後的技能指令是 `/bdd-skills:bdd-local-test`。因儲存庫為私人，使用者的 Git 憑證需能讀取 `zokmi/bdd-skills`；若 GitHub CLI 已登入但 Git 複製仍失敗，可在 PowerShell 執行 `gh auth setup-git`，再重新安裝。

## 安裝到 Codex

在終端機執行：

```text
codex plugin marketplace add zokmi/bdd-skills
codex plugin add bdd-skills@zokmi-bdd-skills
```

此儲存庫為私人專案，執行指令前，Git 憑證須能讀取 `zokmi/bdd-skills`。若 GitHub CLI 已登入但 Git 複製失敗，可執行 `gh auth setup-git` 後重試。

安裝後可在 Codex 使用 `bdd-local-test` skill。

實際執行測試前，請先閱讀目標專案的指引與環境設定，並依 `SKILL.md` 的安全確認流程操作。
