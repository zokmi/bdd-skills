# 全通過後的整合與封存

### 7-0. 詢問收尾模式

全部情境通過後，先詢問使用者：「這次要合併回 develop、轉為正式 feature 分支，還是只保留測試報告？」記錄選擇；使用者本輪已明確指定模式時直接沿用，不重問。尚未回答時保留報告、證據與 worktree，不執行合併、推送或尚未授權的 issue 更新，也不刪除證據或 worktree。停止服務獨立依〈服務停止〉判定；已授權且完成的 issue 更新不因等待模式選擇而失效。

| 模式 | 後續流程 |
|------|----------|
| 合併回 develop | 執行〈7-1〉至〈7-3〉，包含合併後複測、遠端核對、issue 更新及封存清理。 |
| 轉為正式 feature 分支 | 執行下列分支轉換；保留工作區與證據供後續開發。 |
| 只保留測試報告 | 保存最終報告；需要封存時只執行〈7-3〉步驟 1，不更新 issue 或自動移除 worktree。 |

**轉為正式 feature 分支**：先顯示目前分支、HEAD、工作區異動與建議的 `feature/<單號>-<主題>` 名稱，詢問使用者確切名稱；本輪已指定名稱時沿用，專案有命名規範時依規範建議。用 `git check-ref-format --branch <名稱>` 檢查名稱。若目前已在指定分支，直接沿用；需要轉換時才檢查本機及遠端同名分支，名稱已存在就回報並重新詢問，不覆蓋或強制改名。無法查證遠端時保留現況並回報，不把查詢失敗當成名稱不存在。

- 目前是本輪專用分支時，使用 `git branch -m <名稱>` 改名；若為 detached HEAD 或目前在 `develop`、主分支或共用分支，使用 `git switch -c <名稱>` 從目前 HEAD 建立分支，保留原分支。已在使用者指定的 feature 分支時沿用。
- 轉換後核對分支名稱、HEAD 與工作區異動；HEAD 和未提交內容須保持一致。不將未提交異動自動提交，不刪除舊遠端分支。改名後若仍追蹤舊名稱的 upstream，解除該追蹤，避免後續誤推。
- 遠端推送僅在使用者已要求時，以非強制方式推送並設定同名 upstream；否則記「僅本機轉換」。推送失敗保留本機分支並記錄原因。
- 將原分支、正式名稱、受測 SHA、推送狀態與 worktree 保留原因寫入〈收尾紀錄〉。此模式不執行〈7-1〉的 develop 合併或 issue 結案，不自動清理 worktree；若使用者另有要求更新 issue，且 BDD 全通過與 issue 更新均完成，仍依〈服務停止〉自動停止本輪 worktree 服務。需要本機封存時依使用者要求處理。

以下〈7-1〉的合併流程及 worktree 清理規則只適用於使用者選擇「合併回 develop」；〈服務停止〉依 BDD 與 issue 的實際完成狀態判定，不受分支模式限制。

### 7-1. All pass 後更新 issue 並合併回 develop

使用者已選擇「合併回 develop」後，依序完成本節，不逐步重問。先保留 `evidence/`，不要急著壓縮或刪除：issue 要附的是**最後一輪修正後的實際截圖**，不是第一輪失敗畫面。每一步把成功狀態寫入〈收尾紀錄〉；任何一步失敗就停止後續合併或更新，不宣稱「已結案」，把已完成的部分、錯誤與下一步回報使用者。若使用者明確只要測試報告、不要更新 issue 或合併，遵照該次要求。

1. **確認目標與準備提交**：由使用者指定的單號、分支或專案設定找出唯一 issue 與其系統（如 Redmine），確認目前是對應的功能分支、遠端 `develop` 存在、最新一輪所有情境全通過。若單號、issue、目標 repo 或 `develop` 不明，先查專案文件與遠端；仍無法唯一確認就停止收尾並回報。檢查原有未提交異動，只挑本次修正與專案允許追蹤的 BDD 檔案提交，不夾帶其他人的變更；無法分離時停止合併並說明。提交修正後，從**乾淨的受測 commit** 再完整重跑一次，更新 `verification.json` 與報告；未通過就回到〈6-1〉，不得合併。若報告受版控追蹤，測後另提交純報告更新並確認沒有改動受測程式，保留真正受測的 commit SHA。
2. **合併與驗證 develop**：先把功能分支的 `.bdd/` 報告、`verification.json` 和新舊證據保存在可讀的暫存位置；若這些檔案未進版控，整合工作區不會自動帶入。`git fetch origin develop`，從最新 `origin/develop` 建立隔離的整合工作區；用 `git log origin/develop..<功能分支>` 與 diff 確認待合併範圍沒有無關變更，再將已驗證功能分支合併進去。把前輪材料帶到整合工作區，保留舊輪次檔名、不覆蓋既有證據，後續截圖使用新的 `R<輪次>_`。
   **衝突全部落在 `.bdd/modules/` 底下時自行解**，做法見 [模組情境集](modules.md)〈並行分支撞號〉；合併後一律跑 `bdd-modules.ps1 -Lint`，有問題先改號再重跑。
   遇衝突就保留原分支與整合工作區供檢查，停止並回報衝突檔案；不動 `origin/develop`，不推未解衝突版本。合併後依〈1-1〉及本流程在整合工作區**完整重跑所有情境**，確認 API、UI、資料庫與既有整合沒有退步；若有失敗或阻塞，不推 `develop`，回報原因與證據。全部通過才用非強制的 `git push origin HEAD:refs/heads/develop` 推送整合工作區的 HEAD，再查遠端 SHA 核對；遠端前進、權限不足或分支保護拒絕時，不用 `--force`，回報本機結果與待處理步驟。若原本就在 `develop`，跳過合併，但仍要完整複測、正常推送並核對遠端版本。這輪受測程式 SHA 與最後的遠端 HEAD 都要記錄。
3. **更新對應 issue**：只在 `develop` 合併／推送及合併後驗證成功後，用可用的 issue 工具追加「問題或需求、根因、修正內容、測試範圍與全通過數字、功能分支與 develop 的受測 SHA、報告位置」說明，並**實際上傳最後一輪的修正後截圖**，逐張說明畫面證明了哪個情境。優先先上傳附件、取得可用附件識別或連結，再一次儲存註記；若是 Redmine，先讀 `~/.redmine-issue-guides/SKILL.md`（存在時）與專案指引，保留原概述與驗收標準，在適當欄位追加註記；狀態只依專案流程更新。
   上傳前檢查截圖不含帳密或不應外傳的資料，並以 `mask-evidence.ps1 -Status` 確認要上傳的圖片全部是 `masked`；有 `unmasked`／`stale` 就先遮罩、登記再上傳。確認 issue 註記與每張截圖附件真的儲存成功，記下 issue 連結及附件清單。若註記已儲存但附件失敗，分別記錄「註記已更新／附件未完成」，重試前先讀現有註記，避免重複留言。沒有可用工具、附件上傳失敗或權限不足時，保留截圖與可貼上的說明，回報使用者；不要假稱已更新或只貼尚未上傳的圖片連結。
4. **準備完成紀錄**：在報告〈收尾紀錄〉先列出合併前後 SHA、`develop` 遠端核對、合併後複測結果、issue 連結、修正後截圖與上傳狀態。issue 更新成功後才清理服務，依〈7-2〉同步最終報告，再依〈7-3〉封存與清理 worktree；避免遠端或 issue 附件停在舊狀態。當收尾任何一項未完成時，明確區分「本機 all pass」與「develop 已合併／issue 已更新」。

### 服務停止

**停止服務的共用條件**：最新一輪 BDD 全部通過（失敗、阻塞、未執行皆為 0），issue 註記已確認儲存成功，且本輪必要證據附件均已確認上傳成功。UI 情境須附最後一輪修正後截圖；純 API／DB 情境沒有截圖需求時，記「截圖不適用」，確認所需請求／回應或查詢證據已附到 issue 註記或附件，不要求產生無關截圖。

條件全部成立後，立即自動停止本輪 worktree 啟動的服務，不必再次詢問使用者，也不等待收尾模式選擇、最終報告同步、ZIP 上傳或 worktree 移除。停止服務後仍保留工作區與證據，後續依所選收尾模式處理。issue 未更新、更新失敗或必要證據未完成時，不自動停止，回報部分完成狀態。本規則不授權額外更新 issue。

**證據先維持 `evidence/` 原狀**，供 issue 上傳、報告連結與最後檢查使用。不要提前刪除原圖或只壓 `evidence/`；最終依〈7-3〉把 `.feature`、`REPORT.md`、`verification.json` 與全部證據一次封成完整 BDD 包。若舊輪次已有 `evidence.zip`，保留它及本輪新證據，不能覆蓋舊檔；封存腳本會把它攤平併入，不必事先手動處理。

**達成上述條件且在 worktree 裡測時，逐一停止本輪功能與整合 worktree 綁在各自 `127.0.0.N` 上的前後端服務**，
釋放埠號與記憶體（不必問使用者）。有任何失敗、阻塞或未執行就不停，保留給下一輪複測；主目錄（`isWorktree=false`）一律不停。

1. 先核對背景工作確實屬於本輪 worktree 啟動的服務，再用可用的背景工作停止工具結束（例如 `run_in_background`／`TaskStop`）；不停止其他工作區或無法確認歸屬的背景工作。
2. 在每個本輪 worktree 的目錄內分別跑停止腳本，帶上該 worktree 使用 `loopback-slot.ps1` 時的埠號，收掉殘留的子程序與先前 session 留下的服務：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/stop-slot-services.ps1" -Ports <同上的埠>
   ```
   腳本只停「監聽在本 worktree 專屬 IP 上、且執行檔或命令列位於本 worktree 路徑下」的程序（連同 `dotnet run`／`npx` 等啟動器）；
   主目錄的 `127.0.0.1`、綁 `0.0.0.0`／`::` 的程序、路徑不在本 worktree 的程序都只列在 `skipped`，不會動。
   不確定時先加 `-DryRun` 看會停哪些。
3. 輸出的 `remaining` 不為空（仍有埠在監聽），或 `skipped` 裡有本該屬於本 worktree 的服務，就**回報使用者**，不要改用 `taskkill` 自己硬停。
4. 在 `REPORT.md` 標題表格填「服務狀態」列。

### 7-2. 同步最終報告

服務清理後，才把它的**實際結果**填進 `REPORT.md` 與〈收尾紀錄〉，連同最後一輪 `verification.json` 核對。報告的「證據封存」欄先寫「待依〈7-3〉產生完整 BDD 封存；實際檔案與 SHA-256 見 issue 後續註記或最終回覆」，避免把還沒產生的檔案寫成已完成。本次適用〈7-1〉時，若報告受版控追蹤，只提交本次產出的報告與專案允許的證據檔，確認受測程式未變，再非強制推送到 `origin/develop` 並核對新遠端 HEAD。報告內記「受測程式 SHA」及**提交報告前**的遠端 HEAD；報告 commit 的 SHA 要在推送後寫進 issue 後續註記或最後回覆，不能預先寫進同一份報告造成自我參照，也不能把純文件 commit 冒充受測版本。若 `.bdd/` 被忽略，將最終版 `REPORT.md`、`verification.json` 與證據保留到〈7-3〉封存並上傳；此前不要刪除 worktree。若上傳或推送失敗，保留本機檔案並回報「程式已合併，但最終報告同步未完成」及錯誤；不要重貼已存在的 issue 註記。若使用者明確只要測試報告而未執行〈7-1〉，最終報告依專案規範保存，不自行推送 `develop` 或更新 issue。

### 7-3. 最終 BDD 封存與 worktree 清理

預設流程在 `develop` 的程式與最終報告推送、遠端 SHA 核對、issue 的說明與修正後截圖附件皆成功後，**自動封存完整 BDD 輸出並清理本輪 worktree**。若使用者本次明確只要測試報告、不執行〈7-1〉，可依步驟 1 封存，但不執行 issue 上傳或自動刪除既有 worktree。預設流程任一步未完成就保留原始資料與 worktree，回報卡住的步驟。

1. 封存到**本機封存庫**（不要自己挑「worktree 上層」之類的位置；worktree 開在 repo 底下時，那會落進主 checkout）：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/archive-bdd.ps1" -Dir <最終 .bdd/單號-主題>
   ```
   封存位置依 `-ArchiveRoot` → 環境變數 `BDD_ARCHIVE_ROOT` → `.bdd/config.json` 的 `archiveRoot` → `<使用者目錄>/bdd-archives/<主 checkout 資料夾名>/` 決定，落在受測 repo 任何 worktree（含主 checkout）內就拒絕。腳本會攤平舊 `evidence.zip`、檢查每張圖片都有遮罩登記、**放入受測 commit 當時的模組情境（`features/`）、截圖轉成無損 WebP（有支援 WebP 的 Python Pillow 時；沒有就保留原格式並在 `warnings` 提醒）**、依內容去重、寫入 `bdd-manifest.json`、逐檔比對 SHA-256，並在封存庫的 `index.jsonl` 登記；同主題的舊封存標為 `superseded`。回傳封存檔絕對路徑、SHA-256、大小、檔案數與去重數、`warnings`。缺必要檔案、有未遮罩圖片或驗證失敗時不產生封存檔，照錯誤訊息處理後重跑，不要繞過檢查。細節見 [BDD 封存、遮罩與清理](archive.md)。
2. 將 ZIP **實際上傳到對應 issue**，確認附件可下載；在 issue 後續註記補充檔名、SHA-256、檔案數、受測程式 SHA 及報告 commit SHA。輸出 `exceedsAttachmentLimit` 為 true 時，先依 references 的做法拆分或改附最後一輪截圖，並註明完整封存位置。確認可下載後登記狀態：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-archive-index.ps1" -Mark -Archive <封存檔> -Status uploaded-verified -Attachment <附件 ID 或網址>
   ```
   上傳失敗時保留 worktree 與封存檔，狀態維持 `local-only`，回報「封存已建立／issue 附件未完成」，不要假稱已封存到 issue。
3. 清理工作區證據：對每個待處理的 worktree（與本輪輸出所在的主 checkout）先跑 `prune-bdd.ps1 -Repo <路徑>` 看計畫，確認本輪輸出目錄為 `prune` 後加 `-Apply`。腳本只在證據內容全部收在 `uploaded-verified` 的封存裡時，刪除 `evidence/` 與 `evidence.zip`；`keep` 的項目照原因處理，不手動刪除。
4. 僅清理本輪使用、能從 `git worktree list --porcelain` 對上絕對路徑的功能與整合 worktree；主 checkout、其他人的 worktree 一律保留。先確認 `develop` 遠端核對成功、ZIP 已在所有待刪 worktree 外且附件可讀、服務已依停止腳本清理。逐一檢查 `git status --porcelain --untracked-files=all` 與被忽略的 BDD 輸出；本輪 `.bdd/<單號-主題>` 的證據應已在步驟 3 清掉；`prune-bdd.ps1` 判為 `keep` 的（例如封存後又新增證據），先重新封存、上傳並登記，再進行清理。被忽略的 `.bdd/` 剩下的 `.feature`、`REPORT.md`、`verification.json`、`masking.json` 已收在封存裡，只對屬於本輪的 BDD 輸出目錄，在核對解析後絕對路徑仍位於目標 worktree 內後移除。其他未提交、未追蹤或忽略檔案一律保留並回報，不使用 `--force`。
5. 從目標 worktree **外**執行 `git worktree remove <核對過的 worktree 絕對路徑>`，再以 `git worktree list --porcelain` 確認目標已不在清單；刪除失敗就保留現場、回報原因，不自行遞迴刪除整個 worktree。將每個實際清理結果補到 issue 後續註記或最終回覆；已封存的 `REPORT.md` 只記預定清理狀態，避免修改 ZIP 造成 SHA-256 失效。

最後列出本次建立的 `BDD-` 測試資料，**問使用者要不要清除**，不要自己刪。
回覆依模式提供實際結果，未執行的流程不列成待完成：

- **共同欄位**：收尾模式（未選擇時寫待選擇）、受測版本、通過／失敗／阻塞／未執行數字、報告位置、服務停止結果與 worktree 保存狀態。
- **合併模式**：補功能分支與 develop 受測 SHA、合併與遠端核對、issue 及證據連結、封存絕對路徑與 SHA-256／大小／檔案數／去重數／實際索引狀態，以及證據和 worktree 清理結果。
- **feature 模式**：補原分支 → 正式分支、HEAD 與未提交內容核對、upstream／推送狀態、worktree 保留位置；另有授權且執行的 issue 更新或封存才附結果。
- **報告模式**：補本機保存位置；有要求本機封存才附封存結果。

任何已選流程的步驟失敗，列出卡住的步驟、錯誤與下一步；同步後複測另說明與上一輪的差異。
