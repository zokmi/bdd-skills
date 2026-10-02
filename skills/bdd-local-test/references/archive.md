# BDD 封存、遮罩與清理

`SKILL.md`〈6〉截圖遮罩與〈7-3〉最終封存的操作細節。腳本都在 `<skill 目錄>/scripts/`，輸出皆為 JSON。

## 三層儲存

| 層 | 位置 | 存什麼 | 生命週期 |
|----|------|--------|----------|
| 工作區 | `<worktree>/.bdd/<單號-主題>/` | `REPORT.md`、`verification.json`、`masking.json`、`evidence/`（模組情境在 `.bdd/modules/`，不在這裡） | 證據在封存並確認上傳後由 `prune-bdd.ps1` 清掉；報告保留 |
| 本機封存庫 | 預設 `<使用者目錄>/bdd-archives/<主 checkout 資料夾名>/` | `<單號>/<輸出資料夾名>-<短 SHA>-<時間戳>.zip` 與 `index.jsonl` | 長期保存，只增不改 |
| issue 附件 | 對應 issue | 與本機封存庫同一個 ZIP | 正式紀錄 |

**封存庫不可放在受測 repo 的任何 worktree 內（主 checkout 也算）**。舊版建議的「worktree 上層 `bdd-archives/`」在 worktree 開在 `<repo>/.claude/worktrees/` 底下時，會落在主 checkout 的 `.claude/bdd-archives/`，造成未追蹤檔案、且清理主目錄時會一起被刪；新版腳本會直接拒絕這種位置。

## 專案設定 `.bdd/config.json`（選用）

```json
{
  "archiveRoot": "~/bdd-archives/my-repo",
  "maxAttachmentBytes": 5242880,
  "webp": "auto",
  "mask": {
    "required": true,
    "selectors": [".header-avatar", ".user-name", "[data-pii]"],
    "rects": [
      { "name": "header-avatar", "glob": "*_SB-10_*.png", "rect": [1220, 0, 1440, 80], "color": "#FFFFFF" }
    ]
  }
}
```

| 欄位 | 說明 | 未設定時 |
|------|------|----------|
| `archiveRoot` | 本機封存庫根目錄，必須是絕對路徑，可用 `~` 開頭 | 依序看 `-ArchiveRoot` 參數、環境變數 `BDD_ARCHIVE_ROOT`，最後用預設位置 |
| `maxAttachmentBytes` | issue 附件大小上限（Redmine 預設 5 MB，以站台設定為準） | 不檢查 |
| `webp` | `auto`：有支援 WebP 的 Python Pillow 就把截圖轉成無損 WebP；`off`：不轉 | `auto` |
| `mask.required` | 圖片沒有有效遮罩登記就拒絕封存 | `true` |
| `mask.selectors` | 截圖前要遮蓋的元素（CSS 選擇器） | 由當次判斷畫面上的個資元素 |
| `mask.rects` | 事後依座標塗色的規則，`rect` 為 `[左, 上, 右, 下]` 像素 | 無 |

設定檔先找本 worktree 的 `.bdd/config.json`，沒有再找主 checkout 的。是否進版控由團隊決定。

## 遮罩：在截圖當下處理

目的是讓未遮罩的原圖**從來不落地**，整個流程只產生一份可外傳的證據，不再有「原檔＋遮罩版」兩個封存。

1. **截圖前注入遮罩樣式**（首選）。Playwright MCP 用 `browser_evaluate`，Node Playwright 用 `page.addStyleTag`：
   ```js
   () => { const s = document.createElement('style'); s.id = 'bdd-mask';
     s.textContent = `.header-avatar, .user-name, [data-pii] { filter: blur(8px) !important; }`;
     document.head.appendChild(s); }
   ```
   Node Playwright 的 `page.screenshot({ mask: [locator] })` 也可以。選擇器以 `mask.selectors` 為準；沒有設定時，依畫面判斷帳號名稱、頭像、Email、電話、身分證號等欄位。截完圖照常操作，頁面重新導覽後要再注入一次。
2. **登記**：截圖確認已遮罩後，登記到 `masking.json`（記錄當下的 SHA-256，之後檔案被改動就會失效）：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/mask-evidence.ps1" -Dir <輸出資料夾> -Mark -Pattern 'R2_*' -Method css
   ```
   畫面本來就沒有個資（例如登入前頁面、純 API 回應截圖）時用 `-Method exempt -Note '<理由>'`，理由必填。
3. **補救**：已經存在的未遮罩截圖，用 `mask.rects` 規則塗色並自動登記：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/mask-evidence.ps1" -Dir <輸出資料夾> -Apply
   ```
4. **檢查**：`-Status` 列出每張圖是 `masked`、`unmasked` 或 `stale`（登記後又被改）。上傳 issue 與封存前都要是全部 `masked`。

不要用 exempt 規避遮罩；看不出畫面有沒有個資時，當作有。

## 封存

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/archive-bdd.ps1" -Dir <最終 .bdd/單號-主題>
```

腳本依序：

1. 檢查 `REPORT.md`、`verification.json` 與證據都在、沒有符號連結；情境來自輸出資料夾的 `.feature`（舊格式）或 `verification.json` 最後一輪的 `scenarios`，兩者都沒有就停止。
2. **攤平**：舊輪次的 `evidence.zip` 解回 `evidence/`；同名同內容略過，同名不同內容就停止。`evidence.zip` 本身不收入封存。
3. **遮罩檢查**：每張圖片都要有有效的遮罩登記，否則列出缺漏的檔案並停止。
4. **情境快照**：依 `scenarios` 從受測 commit 取出當時的 `.feature`，放在 ZIP 的 `features/<模組路徑>/`。紀錄的 blob 與受測 commit 不符，或受測時情境未提交，就停止。
5. **轉無損 WebP**：`evidence/` 底下的 PNG／JPG／BMP 轉成無損 WebP，解碼回來逐像素比對一致、而且檔案變小才採用，否則保留原檔並記在 manifest 的 `webp.skipped`。ZIP 內的 `masking.json` 改以 `.webp` 登記（保留 `derivedFrom`），`.md` 檔裡的截圖連結改成 `.webp`；工作區的原檔都不動。沒有 Pillow 時保留原格式，`warnings` 出現 `webpUnavailable`。
6. **去重**：內容相同的檔案只存一份，其餘記在 `bdd-manifest.json` 的 `aliases`。
7. 打包成暫存檔，逐檔核對 SHA-256 後才搬到封存庫；任何失敗都不留半成品。
8. 在 `index.jsonl` 追加 `created`，並把同 repo 同主題、尚未被取代的舊封存標為 `superseded`。

受測 SHA 預設取 `verification.json` 最後一輪的 `head`，單號取資料夾名稱開頭的數字；必要時以 `-Commit`、`-Issue` 指定。輸出的 `exceedsAttachmentLimit` 為 true 時，上傳前要拆分，或 issue 只附最後一輪截圖，並註明完整封存只留本機。

ZIP 內第一層是輸出資料夾名稱，`bdd-manifest.json` 記錄每個檔案的 SHA-256、大小、aliases、受測 commit、是否已遮罩。只用系統內建解壓縮也能看到報告與所有不重複的截圖；要完整還原（含 aliases）用：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/extract-bdd.ps1" -Archive <zip> -To <repo>/.bdd
```

還原時不覆蓋既有檔案（同內容略過、不同內容停止），也不解出 manifest，所以還原後的資料夾可以直接接續下一輪並再次封存。

## 重新壓縮既有封存

1.3.0 以前的封存（或封存時沒有 Pillow）截圖仍是 PNG，可以事後轉成無損 WebP：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/recompress-bdd.ps1" -Archive <zip>
```

路徑與檔名不變，索引追加 `recompressed` 事件，狀態（例如 `uploaded-verified`）不變。issue 上的附件仍是原本的 PNG 版，那是正式紀錄，不重新上傳；索引以 `issueCopySha256` 記錄那一版的 SHA-256。`prune-bdd.ps1` 以 manifest 的 `originalSha256` 比對工作區原圖，所以重新壓縮後仍可據以清理。

## 索引與狀態

`index.jsonl` 每行一個事件，只增不改；每個封存檔的目前狀態以最後一筆 `status` 為準：

| 狀態 | 意義 |
|------|------|
| `local-only` | 剛建立，只在本機 |
| `uploaded` | 已上傳 issue，尚未確認可下載 |
| `uploaded-verified` | 已上傳並確認附件可下載；**只有這個狀態允許清理工作區證據** |
| `superseded` | 同主題有更新的封存；檔案保留，但不再當作清理依據 |

`recompressed` 事件只換檔案內容，不改狀態。

上傳並確認後登記（附件 ID 或網址必填；登記前會重算 SHA-256，與建立時不同就拒絕）：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-archive-index.ps1" -Mark -Archive <zip> -Status uploaded-verified -Attachment <附件 ID 或網址>
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-archive-index.ps1" -List -Repo . -Issue <單號>
```

## 清理工作區證據

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/prune-bdd.ps1" -Repo <worktree 或主 checkout>          # 只列計畫
pwsh -NoProfile -File "<skill 目錄>/scripts/prune-bdd.ps1" -Repo <worktree 或主 checkout> -Apply   # 實際刪除
```

只有 `evidence/` 每個檔案、`evidence.zip` 每個項目的**內容**都收在 `uploaded-verified` 的同主題封存裡，才會刪除 `evidence/` 與 `evidence.zip`。`.feature`、`REPORT.md`、`verification.json`、`masking.json` 一律保留。結果為 `keep` 的項目會寫明原因（未上傳、封存後又新增證據、封存檔不存在或被改動等），照原因處理，不要手動刪除。

## 遷移舊資料（使用者要求搬移時）

舊版留下的資料分兩種，處理方式不同：

1. **舊版封存 ZIP**（例如主 checkout 的 `.claude/bdd-archives/*.zip`，沒有 manifest）：原檔匯入封存庫的 `<單號>/legacy/`，不重新打包，SHA-256 不變；issue 上有同一個檔案時，再登記 `uploaded-verified`。
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-archive-index.ps1" -Import -Archive <舊 zip> -Repo . -Issue <單號> -Topic <輸出資料夾名> -Commit <短 SHA> -Note "<來源說明>" -Move
   ```
2. **工作區的 `.bdd/<單號-主題>/`**（含 `evidence/` 或 `evidence.zip`）：照一般流程封存。舊截圖沒有遮罩登記，而且不會上傳時，用 `-AllowUnmaskedReason "<理由>"` 明確放行，manifest 會記下未遮罩清單與理由；這種封存**不可上傳 issue**。之後用 `prune-bdd.ps1 -AllowLocalOnly` 清理工作區證據，清完後本機封存庫就是唯一的完整副本。

進行中的單（功能分支還沒併回、還會再跑下一輪的）不要遷移。

## 測試

```bash
pwsh -NoProfile -Command "Invoke-Pester -Path <skill 目錄>/tests -Output Detailed"
```
