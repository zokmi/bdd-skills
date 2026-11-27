---
name: bdd-local-test
description: 用於撰寫或審核 BDD／Gherkin／feature 驗收情境、維護模組業務行為規格、本機 UI／API／DB 驗證、Playwright CLI 測 localhost、失敗修正與複測，以及 cherry-pick／merge／跨 repo 同步後的結果有效性確認。適用互動畫面、外部系統 API 與事件／排程觸發的業務流程。
---

# BDD 情境與本機驗證

先確認使用者要撰寫情境、本批實測、引用既有結果，或整合交付。讀受測專案的 `AGENTS.md`／`CLAUDE.md`、README 與該 worktree 的 `.bdd/config.json`，以實際設定決定基準、環境與帳號。下列指引按當前工作選讀，交接提供本輪 ID、可讀的檔案路徑與證據位置。接手者無法讀取原件時，附上該項需要的內容。

**只合併回 develop** 時，直接依[合併檢核](references/closeout.md#develop-合併檢核)在整合候選版本取得全單元測試通過或編譯成功，任一項即可。合併本身不觸發 BDD。既有 feature BDD 結果保留原輪次與受測 SHA。

## 撰寫或修改情境

- 以需求定義角色可觀察的成功與異常結果，包含外部 API、事件與排程。新增或實質修改的情境標 `@P0`／`@P1`／`@P2`。實作不符需求時標 `@已知缺陷`，保留可重現的失敗。工程調整依風險另列技術驗證。[情境寫法](references/feature-guide.md) · [情境等級](references/feature-guide.md#情境等級)
- 情境歸入 `.bdd/modules/<portal>/<主路由>/`。新增、修改、刪除、改名或整併 Feature，或修改影響歸屬／規則的 `MODULE.md`，自動執行 `node bdd.mjs modules --lint` 並派獨立唯讀子代理審核。必修項修正後複審，無法獨立審核時記阻塞。只要情境時，在審核與未執行紀錄完成後停止。[模組規格](references/modules.md) · [文件合規審核](../bdd-scenario-audit/SKILL.md)

## 選取本輪範圍

- 先固定基準、候選版本，靜態檢查並審查 diff。確認不影響行為的純文件異動可走 FAST，局部行為改動走 TARGETED，高風險、PR／Release 或明確全套要求依閘門走 FULL。工程批次可只含 `quality-plan --engineering-checks`，核准、派工與結果沿用相同檢查 ID。[品質閘門](references/quality-gate.md)
- 同一 issue 的新回饋預設只驗本批。用 `--previous-verification` 讀上批實測快照，依本批需求與差異選入直接修正、必要前置及受影響回歸。先前已驗項目只在受影響、重現或點名時重驗。缺基準或映射時依 `blockers` 補正，再以本輪 `runId`、選測檔、Feature 及情境 ID 核對送審與派工。[本批選測與擴大範圍](references/scenario-priority.md#同單多批回饋)

## 執行與複測

1. 實測前閱讀[分階段工作流程](references/execution-workflow.md)。依[送審前準備](references/scenario-review.md#送審前選取範圍與編製清單)列出各斷言的手段與證據。小型 TARGETED 由一名唯讀規劃者一次準備，其餘實測依序派兩次準備。未參與規劃或執行的子代理獨立審核 PASS 後才派工。文件合規可合併審核，分別記錄。
2. **先取得資料庫目標的明確確認。** 展示實際主機／執行個體、庫名、環境、設定來源及讀寫範圍。確認後才可做 UI／API／DB 實測、啟動可能連庫寫入的服務、執行存取資料庫的工程檢查或派工。包含本機與唯讀情境。同任務目標與授權範圍相同可沿用確認，改變時須重新確認。缺少確認或帳密時列阻塞。[環境確認與複測](references/local-execution.md)
3. 主代理從派工起持續監督與彙整，每輪實測即使只有一組也交給實測子代理。無法派工時停止實測並記阻塞。先跑核心異動與必要前置，再跑其餘核准項目。當服務與測資都需準備且有兩個名額時分派並行。[分組、準備與交接](references/parallel-bdd.md)
4. 逐項記錄真實操作與觀察值。優先用[內建工具](references/test-kit.md)。需要登入時依[登入自動化](references/authentication.md)。UI 使用每組具名的 Microsoft Playwright CLI session，先通過 localhost 路由探測。同一情境可用 `run-code` 批次執行相容的導航與 locator 檢查，保留每項斷言與失敗位置。多 worktree 的臨時埠、固定原埠與 `portMappings` 依[隔離指引](references/worktree-loopback.md)處理。
5. 一般文字或狀態可用 locator／文字快照。整輪可零截圖。只保留清單核准的目視或交付證據，同畫面共用，遮罩登記後連入報告。缺陷修正後重啟受影響服務再測。失敗、阻塞、未執行皆為零且證據齊備，才可記全通過。[實測與證據](references/local-execution.md)

## 報告、接續與交付

- 用檔案編輯工具撰寫 Feature 與 `REPORT.md`。每輪實測用 `verification --record --brief` 取得結果計數與輪次位置，完整的 `verification.json`、報告與必要證據存於 `.bdd/<單號>-<主題>/`。Git 只收模組情境、`MODULE.md` 與共用設定。既有追蹤輸出依授權遷移。[報告與驗證紀錄](references/reporting.md) · [版控分工](references/version-control.md)
- 引用舊結果或在 cherry-pick／merge／跨 repo 同步後接續驗收，以 `node bdd.mjs verification --check --brief` 核對 repo、commit 及工作區狀態，依判定複測受影響項目。[範圍與版本比對](references/workflow-and-scenarios.md)
- 本批或指定整單全數通過且證據齊備時，自動派獨立子代理審核結果報告。已授權回寫 issue 時，再完成一致性審核。兩項都 PASS 後由專責子代理逐條回寫並回讀，附本批來源、版本、結果與證據。每次回寫或更正後，由未參與寫入者唯讀審核線上內容，PASS 後才依收尾條件處理服務與分支。只整理既有報告時，保留原輪結果並註明本次未新增實測。[階段與最終交付](references/closeout.md) · [Issue 回覆內容審核](../bdd-issue-reply-audit/SKILL.md)
