# BDD Skills

Claude Code 跨專案 BDD 測試 skill。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。

## 安裝到 Claude Code

Claude Code 2.1.275 以上可在互動工作階段輸入一條指令，加入此私人 marketplace 並安裝 plugin：

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

首次加入 marketplace 時依提示確認，並選擇安裝範圍。安裝後的技能指令是 `/bdd-skills:bdd-local-test`。因儲存庫為私人，使用者的 Git 憑證需能讀取 `zokmi/bdd-skills`；若 GitHub CLI 已登入但 Git 複製仍失敗，可在 PowerShell 執行 `gh auth setup-git`，再重新安裝。

### 手動安裝

若使用較舊版本的 Claude Code，可在 Windows PowerShell 執行：

```powershell
gh repo clone zokmi/bdd-skills
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -LiteralPath ".\bdd-skills\skills\bdd-local-test" -Destination "$HOME\.claude\skills" -Recurse -Force
Test-Path "$HOME\.claude\skills\bdd-local-test\SKILL.md"
```

最後一行應顯示 `True`。如果已經下載此儲存庫，從其上層目錄執行後三行即可。這會把完整的 skill 資料夾安裝到個人 skills 位置，供本機所有 Claude Code 專案使用。

若之前已手動安裝，plugin 版本會以 `/bdd-skills:bdd-local-test` 出現，舊版則仍以 `/bdd-local-test` 出現。

實際執行測試前，請先閱讀目標專案的指引與環境設定，並依 `SKILL.md` 的安全確認流程操作。
