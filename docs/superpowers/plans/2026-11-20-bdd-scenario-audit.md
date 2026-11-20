# BDD Scenario Audit Implementation Plan

**Goal:** 建立唯讀的既有情境合規審查 skill。

**Architecture:** 獨立入口引用同插件 bdd-local-test 的撰寫與模組規範；格式 lint 與語意審核分開報告。

**Tech Stack:** Markdown skill、JSON 評估案例、既有 PowerShell lint。

**Spec:** ../specs/2026-11-20-bdd-scenario-audit-design.md（使用者已確認）。

## Constraints

不改情境、不實測、不啟動服務、不回寫 issue；不改版、不發布、不安裝。保留目前未提交的說明優化。

## Review Focus

需求不足不得宣稱完整合規；合法 API／排程不得誤排除；工程安全驗證不得遺漏；lint 範圍可能大於指定文件；沒有情境不得回報 PASS。

## Task 1: Skill 與發現入口

- [x] 用混合案例取得無新 skill 的 baseline。
- [x] 新增 skills/bdd-scenario-audit/SKILL.md，定義範圍、唯讀流程、規範來源、問題格式與結論。
- [x] 新增 skills/bdd-scenario-audit/evals/evals.json，涵蓋混合情境、需求不足、格式與語意差異、空目錄及範圍隔離。
- [x] 更新 README，說明兩個 skill 的分工與叫用方式。
- [x] 以獨立代理套用新 skill 複驗案例；檢查引用、JSON、diff 並修正。

本輪在目前工作區直接實作，不提交或改動版本；交付新增 skill 與驗證結果。

## 後續發布授權

使用者於實作完成後要求驗證並發布新版本；依此新增授權升版為 1.9.3，執行發布檢查並推送標籤。原先不發布限制僅適用建立 skill 階段。
