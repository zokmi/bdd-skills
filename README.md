# BDD Skills

提供 Claude Code 與 Codex 使用的繁體中文 BDD 測試插件，協助團隊把需求整理成可判定的 Gherkin 驗收情境，透過真實的 UI、API 與資料庫路徑在本機驗證，並保留可追溯的測試報告與證據。

## 插件介紹

`bdd-skills` 目前提供 `bdd-local-test` skill，適合需要將功能異動轉成驗收情境、執行本機測試、處理失敗後修正並重新驗證的專案。它整合繁體中文情境撰寫、Playwright MCP 本機執行、測試證據保存、模組化情境維護，以及 BDD 結果整理與封存流程。

## 內容

- `skills/bdd-local-test/SKILL.md`：將功能異動整理為繁體中文 Gherkin 情境，並在本機執行驗證與產出報告。
- `assets/`、`references/`、`scripts/`：報告範本、寫作參考與本機驗證輔助腳本。
- `evals/`：skill 的評估案例定義。
- `tests/`：封存、遮罩與清理腳本的 Pester 測試（`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests"`）。
- worktree／MCP 設定回歸：`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-WorktreeMcp.ps1`，涵蓋四程序同時分配、slot 重用及錯誤拒絕、獨立 MCP 設定與原埠保留；這些腳本測試不代替產品 UI BDD。
- 跨專案分配回歸：`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-CrossRepoSlot.ps1`，使用真實暫存 Git repo／worktree 驗證首次並行分配、IP 重用與舊 slot 衝突拒絕。
- Chrome 真實導轉實測：`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-LoopbackLive.ps1 -McpCli <已安裝的 @playwright/mcp/cli.js> -ChromePath <chrome.exe> -OutputDir <證據目錄> -UseDefaultRegistry`。建立兩個暫存專案、四個 worktree 及兩個隔離主 checkout，以六組獨立無頭 Chrome／stdio MCP 同時驗證固定 UI 4200、API 9453 的真實 HTTP 身分、目的 IP、Origin 與儲存隔離，保存 `result.json` 後停止程序；不連資料庫、不下載套件。需可建立測試 Git 目錄及啟動本機服務的權限，並預先安裝 Chrome／Playwright MCP。省略 `-UseDefaultRegistry` 僅使用 fixture 專屬登記。

執行本機 UI 情境時，skill 必須用已連線的 Playwright MCP 開啟 localhost；發現產品缺陷會修正、重啟並複測。Playwright MCP 未連線或無法滿足 worktree 隔離時，先排查並修復；仍無法執行的 UI 情境列為阻塞，不得改用 Node Playwright、CLI 或其他瀏覽器工具替代。共用 MCP session 的 UI 情境序列執行。情境照功能模組持續維護在 `.bdd/modules/`，每張單只留本輪結果與證據（見 `skills/bdd-local-test/references/modules.md`）；封存時截圖轉成無損 WebP，約省一半空間。情境寫完會先交給子代理獨立審核（需求對應、預期是否照抄程式、覆蓋缺漏），處理完必修項目才執行，審核方式見 `skills/bdd-local-test/references/scenario-review.md`。截圖當下就遮蓋個資並登記。worktree 開發與相關回歸通過後，自動詢問兩種交付方式：轉為正式 feature 分支或合併回 develop；本任務已指定時沿用，不重問。未回答前保留工作區，不轉換分支、合併或推送；明確只要情境或報告的任務不觸發交付詢問，也不列為第三選項。服務停止獨立依收尾指引判定，BDD 全通過且本機結果與必要證據保存完成後自動停止本輪 worktree 服務與測試瀏覽器，不等待 issue 更新或附件上傳，不等待模式選擇或封存。feature 模式先在功能 worktree 完整 BDD 通過，再確認分支名稱並轉換，保留工作區與證據；僅改名且版本與環境未變不重跑。選擇合併模式時，開發中只測修正與相關回歸，完整驗證集中在最新 `develop` 整合後、推送前一次；同版本推送後只核對 SHA、更新對應 issue 並附修正後截圖；再將完整 BDD 輸出去重封存到本機封存庫（預設 `~/bdd-archives/<repo>/`，不會落在任何 worktree 內），上傳 issue 並登記索引後，清理工作區證據與本輪 worktree。衝突、權限或驗證問題會如實回報。封存細節見 `skills/bdd-local-test/references/archive.md`。

## BDD 版控分工

處理指定 issue 時，最終完整 BDD 全通過且一致性審核 `PASS` 後，主代理自動追加修正項目與驗證說明，上傳最後一輪已遮罩截圖或 API／DB 替代證據，再重新讀取 issue 核對註記與附件。feature 與合併 develop 模式皆適用，不需另問是否回寫；合併模式仍先完成推送與遠端 SHA 核對。明確只要情境／報告或禁止更新 issue 時遵守限定範圍；未另授權不改狀態或關單。無唯一 issue、權限不足、審核未通過或附件失敗時保留證據並分別回報 BDD 與 issue 交付狀態。feature 模式回寫後仍保留 worktree。詳見 [共用 issue 交付](skills/bdd-local-test/references/closeout.md#共用-issue-交付最終完整驗證後自動執行)。

合併收尾在產生最終 ZIP、清理證據或移除 worktree 前，必須先完成 issue 修正註記與最後一輪逐項截圖／替代證據交付，重新讀取 issue 核對儲存與附件可讀性。ZIP 的 `uploaded-verified` 不代表交付完成；未完成時保留原始輸出及 worktree。明確只要報告／本機 ZIP 的任務依限定範圍處理。此關卡由主代理執行，封存與清理腳本不查詢 issue。

開始任何 UI／API／DB 實測前，插件必須展示實際資料庫主機／執行個體、庫名、環境、設定來源及讀寫範圍，並等待使用者明確確認。本機與唯讀情境也適用；只告知或使用者只說「測到全過」不算確認。未確認時不實測、不派實測子代理；同任務目標與範圍未變的複測沿用確認，變更或跨 repo 則重新確認，並在報告保留依據。

每次 BDD 開始前自動執行 `ensure-bdd-gitignore.ps1`，驗證並補齊目標專案忽略規則，保留模組情境及共用設定；重跑不重複新增，衝突回報，既有追蹤產物只列出待處理項目。`-Check` 僅檢查。回歸測試：`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-BddGitignore.ps1`。

同專案多 worktree 保留原 localhost 網址與埠號，禁止修改原始專案設定、系統 hosts 或全域代理。以臨時服務啟動參數綁定各自 loopback IP，並用 `prepare-worktree-mcp.ps1` 產生獨立 MCP 的暫時 localhost 對應；slot 分配加鎖避免同時啟動撞 IP。產生設定後仍須建立獨立 MCP 連線並確認前端與 API 版本，才可並行 UI；無法建立則阻塞。操作見 [worktree 隔離](skills/bdd-local-test/references/worktree-loopback.md)。

每輪實測自動評估子代理分組：兩組以上可安全獨立執行且有可用子代理時，主代理直接派工，不必明說「並行」。先分配情境、檔案與測試資料範圍，每組使用獨立瀏覽器及輸出目錄；需要修改程式時隔離 worktree，共用服務與資料無法隔離的組別序列執行，其他獨立組繼續派工。報告記錄執行模式、實際代理與未派工原因；情境審核不代替實測派工。主代理核對各組證據、版本與情境覆蓋後彙整，整合修正後仍須在最終版本完整驗證。詳見 [子代理並行 BDD](skills/bdd-local-test/references/parallel-bdd.md)；[結構化契約](skills/bdd-local-test/references/parallel-bdd-contract.md) 提供三份 JSON Schema 與唯讀摘要工具，產出 summary.json／SUMMARY.md 供主代理審閱。

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
