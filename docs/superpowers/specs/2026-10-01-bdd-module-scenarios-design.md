# BDD 情境照模組累積、證據照 issue 冷封存：設計

- 日期：2026-10-01
- 對象：`skills/bdd-local-test`（目前 1.3.0 → 目標 1.4.0），以及第一個套用的專案 bsaila
- 狀態：設計已與使用者逐段確認，待審閱 spec

## 1. 背景與目標

### 1.1 現況

每張單的 BDD 輸出放在 `.bdd/<單號>-<主題>/`，裡面混著兩種性質相反的東西：

- **情境**（`.feature`）：描述功能應該怎樣，會隨需求演進。
- **證據**（截圖、`REPORT.md`、`verification.json`）：某個 commit 當下的驗證快照，結案後就不再改。

封存時整個資料夾依 issue 打成 ZIP，放進本機封存庫 `~/bdd-archives/<repo>/`。

### 1.2 實測（bsaila，2026-10-01）

| 項目 | 數字 |
|------|------|
| 封存庫 | 8 個 ZIP、460 個檔案、23 MB |
| PNG 截圖佔比 | 96%（215 張） |
| ZIP 壓縮效果 | 約 4%（PNG 本身已壓縮） |
| 跨封存的同內容重複 | 4 組、0.56 MB（約 2%） |
| 無損 WebP | 省 55%（23.2 → 10.4 MB），畫素不變 |
| 有損 WebP q85 | 省 63% |
| JPEG q85 | 省 29% |

同一個模組被多張單反覆修改（賽制管理有 #5349、#5350、#5354、#5355），情境各自複製一份、逐漸分歧，例如 #5349 與 #5354 都有自己的 `03-shared-spillover.feature`。編號前綴依單子各取，共 27 種。

### 1.3 目標

1. **本機硬碟長期累積要小**（使用者選定的主要目標）。結案後的資料視為冷資料。
2. **同一個模組由多張單修改時，情境只有一份現行版本**，後續的單子在它上面修改，並據以回歸。
3. 每張單的證據仍能獨立閱讀、獨立上傳 issue，可追溯到受測 commit。

### 1.4 已決定的事項

| 決策 | 選擇 | 主要理由 |
|------|------|---------|
| 組織方式 | 情境照模組、證據照 issue | 證據綁 commit 不會再改；情境是會演進的現行規格 |
| 模組邊界 | portal＋主路由（例如 `organizer/schedule-settings`） | 與情境「入口」一致，skill 可從異動檔案推斷，切法穩定 |
| 共用元件／全站樣式情境 | 獨立的 shared 模組（例如 `organizer/shared/category-tabs`） | 下次改同一個元件時能直接拿出來回歸 |
| 既有資料 | 一次整併並重新編號 | 情境集立刻可用，對照表保留追溯 |
| 封存架構 | 方案 A：每單一個獨立 ZIP，截圖轉無損 WebP | 省 55%；物件庫（方案 B）只多省 2%，複雜度與風險高很多 |
| 畫質 | 無損 | 證據不可有壓縮雜訊 |

### 1.5 不做的事

- 內容定址物件庫、跨單去重（只省約 2%）。
- 冷資料再合併成 solid 壓縮檔（WebP 再壓也幾乎省不到空間，且會失去一單一檔的對應）。
- 有損壓縮。
- 改變 issue 層資料夾的路徑。

## 2. 目錄結構與職責

```
<repo>/.bdd/
  modules/                                  ← 模組情境集（進版控，持續維護）
    organizer/schedule-settings/
      MODULE.md
      01-list.feature
      02-editor.feature
    organizer/shared/category-tabs/
      MODULE.md
      01-spillover.feature
    job/data-export/ …
    MIGRATION-2026-10.md                    ← 一次性整併的舊→新編號對照（僅遷移的專案有）
  <單號>-<主題>/                            ← issue 層，路徑不變
    REPORT.md
    verification.json                       ← 新增 scenarios 欄位
    masking.json
    evidence/                               ← 依專案設定忽略，封存並確認上傳後清掉
```

### 2.1 `modules/<portal>/<主路由>/`

- 是「這個功能現在應該怎樣」的唯一一份。
- 情境標籤：模組編號＋來源單號，例如 `@SS-12 @#5349 @#5354 @UI`，記錄哪些單子新增或修改過它。修改紀錄交給 git。
- `.feature` 檔頭的「範圍」改寫為模組層級，例如 `# 範圍：organizer-portal 賽制管理`，不再寫單一單號的分支差異。

### 2.2 `MODULE.md`

只在新增模組時建立，內容：

- 模組名稱與入口路由（可多個）。
- 編號前綴（2–3 字母，整個 repo 內唯一）。
- **對應程式路徑**（glob 清單），skill 依此從異動檔案推斷受影響模組。
- 相關單號清單。
- 已移除的編號：`SS-07 於 #5400 移除：<原因>`。

### 2.3 issue 層

- 不再放 `.feature`。
- `verification.json` 每一輪新增 `scenarios` 欄位：

  ```json
  "scenarios": [
    { "path": ".bdd/modules/organizer/schedule-settings/01-list.feature",
      "blob": "<該檔在受測 commit 的 git blob SHA>",
      "ids": ["SS-01", "SS-02", "SS-12"],
      "role": "changed" }
  ]
  ```

  `role` 只有 `changed`（本單新增或修改）與 `regression`（本單沒改、挑來回歸）兩種。
- `bdd-verification.ps1 -Check` 在 `blob` 與目前 HEAD 不同時判 `rerun`，理由是情境本身被改過。

### 2.4 SKILL.md 流程的對應改動

| 步驟 | 改動 |
|------|------|
| 1 | 輸出分成 `modules/` 與 issue 層兩處 |
| 2 | 依各 `MODULE.md` 的對應程式路徑，找出受影響的模組並先讀現有情境。沒有對應的模組時，依「portal＋主路由」提出新模組（名稱、前綴、程式路徑），請使用者確認後建立 |
| 3 | 在模組裡新增或修改情境；本單沒動到、但屬於受影響模組的情境，挑相關的列為回歸 |
| 3-1 | 審核範圍：本單 `changed` 的模組情境，以及同一 `功能` 內的其他情境（檢查重複或矛盾） |
| 6 | 〈情境修訂〉改的是模組情境，改完依 3-1 送審 |
| 7 | `-Record` 寫入 `scenarios` |
| 7-1 | 依 §3.3 處理撞號；合併後跑 `bdd-modules.ps1` |
| 7-3 | 依 §4 封存 |

## 3. 編號規則與並行分支

### 3.1 編號

- 每個模組一個前綴，登記在 `MODULE.md`，repo 內唯一。
- 模組內流水號；新增的編號 = 目前最大號 + 1。
- **用過的號碼不再重用**；刪除的情境留空號，在 `MODULE.md` 記錄原因。
- 修改既有情境的預期時改在原地，補上本單的單號標籤。

### 3.2 檢查腳本 `scripts/bdd-modules.ps1`

`-Lint -Repo <路徑>`，輸出 JSON；有問題時 exit code 非 0。

檢查項目：

1. 同一模組內編號重複。
2. 跨模組前綴重複。
3. 情境缺少單號標籤，或缺少 `@UI`／`@API`／`@DB`。
4. 使用了沒有登記在 `MODULE.md` 的前綴。
5. 用回 `MODULE.md` 記為已移除的編號。
6. `MODULE.md` 缺少必要欄位。

在 3-1 審核前與 7-1 合併後各跑一次；有問題時不進入執行，也不推 `develop`。

### 3.3 並行分支撞號

情境：兩條分支各自從 `develop` 開出，都新增了 `SS-13`。

1. 7-1 本來就會把功能分支合併到最新的 `origin/develop`，再完整重跑所有情境。撞號在這裡處理。
2. 合併衝突**只出現在 `.bdd/modules/` 底下**（`.feature` 與 `MODULE.md`）時，由 skill 自行解：`.feature` 兩邊的情境都保留，本分支新增的情境改號接在 `develop` 的最大號之後；`MODULE.md` 的相關單號與已移除編號取兩邊的聯集。只要有任何 `.bdd/modules/` 以外的檔案衝突，就照現行規則停止並回報，`.bdd/modules/` 的衝突也不先自行解。
3. 沒有文字衝突、但 `bdd-modules.ps1` 檢查出編號重複時（例如雙方加在不同檔案），同樣把本分支新增的改號。
4. 改號寫進 REPORT〈情境修訂〉，例如「`SS-13`→`SS-15`（與 #5401 撞號）」。合併後重跑那一輪的證據用新編號；前幾輪的舊證據保留原檔名，依對照查找。

## 4. 封存改動

### 4.1 放入情境快照

- 依最後一輪 `verification.json` 的 `scenarios`，用 `git show <受測 commit>:<path>` 取出受測當時的 `.feature`，放進 ZIP 的 `features/<原相對路徑>`。
- 取出內容的 blob SHA 必須等於紀錄值，不同就停止。
- 舊格式（issue 資料夾內含 `.feature`、沒有 `scenarios`）照現行方式收錄。

### 4.2 截圖轉無損 WebP

處理順序：攤平舊 `evidence.zip` → 遮罩檢查（對原圖）→ **轉檔** → 去重 → 打包 → 逐檔驗證。

- 對 `.png`、`.jpg`、`.jpeg` 轉成無損 WebP；轉完後**解碼回 RGBA 逐像素比對原圖**，完全一致才採用。
- 不一致，或 WebP 比原檔大時，保留原檔，manifest 記錄原因。
- manifest 每個檔案新增：`originalName`、`originalSha256`、`encoder`、`lossless: true`；`sha256` 是封存內實際檔案的雜湊值。
- ZIP 內 `REPORT.md` 的圖片連結改寫為 `.webp`，manifest 記錄 `rewrittenLinks`。工作區原檔不動。
- ZIP 內 `masking.json` 改成以 WebP 的雜湊值登記，並保留 `derivedFrom`：原圖的雜湊值與遮罩方式。`mask-evidence.ps1` 接受 `.webp`，讓 `extract-bdd.ps1` 還原後能直接接續下一輪並再次封存。

### 4.3 編碼器

這支 skill 跨專案共用，不可假設一定有編碼器。

1. 使用有 WebP 支援的 Python Pillow（`python`／`python3`／`py -3` 依序嘗試）；轉檔與逐像素驗證都在同一支 Python 輔助程式內完成。
2. 沒有 Pillow：保留原檔，封存仍然成功，`warnings` 加上 `webpUnavailable`，索引的 `created` 事件記錄 `webp: false`。

（2026-10-01 實作前探測：原本規劃優先使用 `cwebp`／`dwebp`，但在 pwsh 7.6／.NET 10 以 `Add-Type` 編譯 System.Drawing 的逐像素比對元件會失敗；PowerShell 逐像素迴圈對 1440×900 的截圖又太慢。依 YAGNI 改為只支援 Pillow。）

`.bdd/config.json` 新增 `"webp": "auto" | "off"`，預設 `auto`。

### 4.4 既有封存重新壓縮：`recompress-bdd.ps1 -Archive <zip>`

- 獨立腳本（不併入 `archive-bdd.ps1`，維持單一職責），與 `archive-bdd.ps1` 共用打包函式。
- 解到暫存目錄，依 §4.2 轉檔並逐像素驗證，產生新 ZIP，驗證通過後才取代舊檔；檔名與路徑不變，讓 issue 註記與索引裡的檔名仍然有效。
- 索引追加 `recompressed` 事件：`source`（舊檔名與 SHA）、`archive`（新檔）、節省的位元組數。
- 狀態繼承：舊檔是 `uploaded-verified` 時，新檔記為 `uploaded-verified`，並註記 `issueCopy: original`。issue 上的附件仍是舊 PNG 版，它是正式紀錄，不重新上傳。
- `prune-bdd.ps1` 比對證據是否已封存時，同時接受 `sha256` 與 `originalSha256`。
- 不支援的舊版 ZIP（`legacy/`，沒有 manifest）也可以重新壓縮，結果記為 `legacy` 加上 `recompressed`。

### 4.5 不變的部分

- 7-1 直接貼在 issue 註記的修正後截圖仍用 PNG：這一步發生在封存前，Redmine 內嵌顯示也最穩。
- 同一份封存內的去重、SHA-256 驗證、失敗不留半成品、封存庫不可放在 worktree 內，這些規則都照舊。

## 5. 錯誤處理

| 狀況 | 處理 |
|------|------|
| 找不到受影響的模組 | 提出新模組請使用者確認；被當成子代理執行、無法確認時，暫時寫在 issue 層，報告標註「模組待定」 |
| `bdd-modules.ps1` 檢查失敗 | 不進入執行，也不推 `develop`；列出問題 |
| 合併時非 `.feature` 檔案有衝突 | 照現行規則停止並回報 |
| `git show` 取不到情境，或 blob 不符 | 停止封存，要求重新 `-Record` |
| 逐像素比對不一致 | 該檔保留原格式，記入 manifest，不停止 |
| 沒有編碼器 | 保留原格式，`warnings` 提醒，不停止 |
| `recompress-bdd.ps1` 驗證失敗 | 保留舊檔，不寫入索引 |

## 6. 測試

Pester（`tests/`）新增：

- `bdd-modules.ps1`：§3.2 的六種檢查，每種至少一個通過、一個失敗的案例；並行撞號的偵測。
- 轉檔：PNG 轉無損 WebP 後逐像素一致（含透明像素與中文檔名）；轉完變大時保留原檔；沒有 Pillow 時退回並出現 `warnings`。
- 情境快照：依 `scenarios` 取出受測 commit 的版本；blob 不符時停止。
- `recompress-bdd.ps1`：產生 `recompressed` 事件、狀態繼承、`prune-bdd.ps1` 可用 `originalSha256` 比對。
- 還原再封存：`extract-bdd.ps1` 還原 WebP 封存後，加入新一輪 PNG 證據，再封存成功。
- 舊格式相容：沒有 `scenarios` 的 issue 資料夾照舊封存與比對。

另外更新 evals：新單子動到既有模組時，修改模組情境而非另寫；並行撞號後改號並記錄。

## 7. 交付物與順序

### 7.1 交付物 1：bdd-skills 1.4.0

- `SKILL.md`：§2.4 的步驟改動。
- 新增 `references/modules.md`：模組切法、`MODULE.md` 格式、編號與撞號規則、遷移步驟。
- 更新 `references/feature-guide.md`、`references/archive.md`、`references/scenario-review.md`、`assets/REPORT-template.md`（新增〈本輪執行情境〉：模組路徑、編號、`changed`／`regression`）、`evals/evals.json`。
- 新增 `scripts/bdd-modules.ps1`、`scripts/recompress-bdd.ps1`、`scripts/lib/BddModules.psm1`、`scripts/lib/BddPack.psm1`、`scripts/lib/BddImage.psm1`、`scripts/lib/bdd_webp.py`；修改 `archive-bdd.ps1`、`extract-bdd.ps1`、`mask-evidence.ps1`、`prune-bdd.ps1`、`bdd-verification.ps1`、`lib/BddArchive.psm1`。
- 三個 `plugin.json` 的版本號改為 1.4.0；README 同步。

### 7.2 交付物 2：bsaila 整併（1.4.0 安裝後，在 bsaila 開功能分支做，單號屆時確認）

1. 提出對照表給使用者確認：每個舊情境歸到哪個模組、新編號、合併／保留／刪除，以及理由。`sport-format-analysis` 由使用者決定歸屬。
2. 確認後寫進 `.bdd/modules/`，整批交給子代理審核（3-1），並通過 `bdd-modules.ps1` 檢查。
3. 刪除各 issue 資料夾裡的 `.feature`（git 歷史與封存都還有），舊的 `REPORT.md`、`verification.json` 不動；新增 `.bdd/modules/MIGRATION-2026-10.md` 記錄舊→新編號對照。
4. 用 `recompress-bdd.ps1` 處理既有 8 個封存。

## 8. 完成判準

- skill：Pester 全數通過；用一個實際模組從寫情境、審核、執行到封存走完整條路徑；撞號情境都能被偵測到並改號。
- bsaila：每個舊情境在對照表裡都有去處；`bdd-modules.ps1` 通過；8 個封存重新壓縮後逐像素一致，封存庫降到約 11 MB。
