# BDD Skills

Claude Code 跨專案 BDD 測試 skill。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。

## 安裝到 Claude Code

在 Windows PowerShell 執行（需要已登入的 GitHub CLI，因為此儲存庫是私人儲存庫）：

```powershell
gh repo clone zokmi/bdd-skills
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -LiteralPath ".\bdd-skills\skills\bdd-local-test" -Destination "$HOME\.claude\skills" -Recurse -Force
Test-Path "$HOME\.claude\skills\bdd-local-test\SKILL.md"
```

最後一行應顯示 `True`。如果已經下載此儲存庫，從其上層目錄執行後三行即可。這會把完整的 skill 資料夾安裝到個人 skills 位置，供本機所有 Claude Code 專案使用。

實際執行測試前，請先閱讀目標專案的指引與環境設定，並依 `SKILL.md` 的安全確認流程操作。
