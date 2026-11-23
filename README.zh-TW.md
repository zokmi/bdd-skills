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

- 本機腳本需要 Git 和 PowerShell 7（`pwsh`）。內建轉送與 API 工具需要 Node.js 18.2 以上。
- UI 測試需要已連線的 Playwright MCP，BDD 實測需要子代理派工支援。
- 使用內建 SQL Server 工具時，在受測專案安裝 `mssql`。封存截圖轉成無損 WebP 時，需要 Python 和支援 WebP 的 Pillow 13.0.0 以上版本。

## 特色

- 依模組維護繁體中文 Gherkin，涵蓋 UI、外部 API、事件與排程。
- 在本機驗證真實 UI、API 與資料庫行為，隔離 worktree，並保存可追溯的報告與遮罩後的證據。
- 獨立審核情境範圍、可判定性、需求覆蓋與格式。

## 技能

- [`bdd-local-test`](skills/bdd-local-test/SKILL.md) — 撰寫驗收情境、協調本機實測及複測，並產出附證據的報告。
- [`bdd-scenario-audit`](skills/bdd-scenario-audit/SKILL.md) — 唯讀稽核情境文件，回報問題位置與修正建議。
