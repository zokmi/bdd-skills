<!-- markdown-translator:05755a4d6577feb6760ff53b5c5f1ea67ae7786fd55ebf33390137f3d19b00b8 -->
# BDD Skills

[English](README.md) · [繁體中文](README.zh-TW.md)

提供 Claude Code 與 Codex 使用的插件，用於撰寫繁體中文 Gherkin 情境並在本機驗證。

## 安裝

**Claude Code 2.1.275 以上** · 在互動工作階段執行。

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

**Codex** · 在終端機執行。

```sh
codex plugin marketplace add zokmi/bdd-skills
codex plugin add bdd-skills@zokmi-bdd-skills
```

## 前置需求

- 模組檢查、品質計畫、驗證紀錄與並行測試摘要使用 Git 和 Node.js。命令入口是 `skills/bdd-local-test/scripts/bdd.mjs`。
- 從 v3.3.0 升級的自動化腳本，請將原有 PowerShell 入口改為 Node 子命令。例如 `bdd-modules.ps1 -Lint` 改為 `node skills/bdd-local-test/scripts/bdd.mjs modules --lint`。
- Windows 的 Node.js CLI 亦負責分配 worktree IP、準備隔離的 Playwright CLI 工作階段及停止已確認歸屬的程序。CLI 會呼叫 Windows .NET Framework 的 C# 編譯器，建立處理原生檔案鎖與程序查詢的小工具。
- 用 `bdd.mjs mask-evidence` 登記或檢查截圖遮罩，`bdd.mjs archive` 建立 ZIP，`bdd.mjs extract` 還原封存。插件已內附 ZIP 套件。依座標對既有圖片補遮罩使用 Windows 的 System.Drawing。
- 用 `bdd.mjs archive-index` 查詢、匯入或標記封存，`bdd.mjs recompress` 重新壓縮歷史截圖，`bdd.mjs prune` 預覽可清理的證據。核對清單後加上 `--apply` 才執行清理。
- 本機 UI 測試使用 Microsoft 的 Playwright CLI，需要 Node.js 20 以上與 Chrome。執行 `npm install -g @playwright/cli@latest` 安裝，再用 `playwright-cli --help` 確認指令可用。BDD 實測也需要子代理派工支援。[Playwright CLI 安裝說明](https://github.com/microsoft/playwright-cli#installation)
- Node.js 18.2 以上可用 ESM 匯入內建轉送與 API 工具。既有腳本若使用 `require()`，請參閱[實測工具遷移說明](skills/bdd-local-test/references/test-kit.md)。使用內建 SQL Server 工具時，在受測專案安裝 `mssql`。封存截圖轉成無損 WebP 時，需要 Python 和支援 WebP 的 Pillow 13.0.0 以上版本。

## 特色

- 依模組維護繁體中文 Gherkin，涵蓋 UI、外部 API、事件與排程。
- 小型單模組 TARGETED 變更由一名規劃者一次選取情境並列出各斷言的驗證手段，再由獨立審核者核對計畫後實測。[範圍選取與審核](skills/bdd-local-test/references/scenario-review.md)
- 在本機驗證真實 UI、API 與資料庫行為，隔離 worktree，並保存可追溯的報告與遮罩後的證據。
- 獨立審核情境範圍、可判定性、需求覆蓋與格式。

## 技能

- [`bdd-local-test`](skills/bdd-local-test/SKILL.md) — 撰寫驗收情境、協調本機實測及複測，並產出附證據的報告。
- [`bdd-scenario-audit`](skills/bdd-scenario-audit/SKILL.md) — 唯讀稽核情境文件，回報問題位置與修正建議。
- [`bdd-issue-reply-audit`](skills/bdd-issue-reply-audit/SKILL.md) — 停止服務或詢問分支處理方式前，核對 issue 上實際刊登的回覆與附件是否符合本次調整與 BDD 實測結果。
