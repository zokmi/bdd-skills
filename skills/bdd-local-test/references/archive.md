# BDD 封存、遮罩與清理

## 目前的截圖保留規則

新測試依[交付與本機截圖清理](closeout.md)執行。只有 issue 驗收明確需要的遮罩截圖才上傳 Redmine 並回讀核對，報告記錄必要附件連結，本機保留非圖片紀錄與其餘核准的驗證截圖。代理驗證時暫存的其他截圖判讀後立即刪除，不封存。以下圖片封存指令僅供歷史封存讀取、還原及追溯。

清理舊封存時，索引狀態用於定位附件。若 Redmine 保存的是 ZIP，重新讀取附件、確認 ZIP 的 SHA-256 相同，並確認待清理圖片可從附件取回。封存內的報告、驗證紀錄及情境先另存並驗證。無法確認副本的圖片保留。混合已確認與未確認圖片的 ZIP，須有可驗證的選擇性清理結果才可移除原檔。

## 歷史封存流程

建立、還原及重新壓縮封存時，ZIP 項目與還原檔案各以 20,000 個為限，還原總大小上限為 4 GiB（含 aliases），manifest 上限為 8 MiB。舊 `evidence.zip` 也適用項目數與還原大小上限。
歷史封存轉 WebP 需要 Pillow 13.0.0 以上的穩定版本，只接受副檔名與實際格式一致的單幀 PNG、JPEG 或 BMP，最多 3,200 萬像素。發版測試使用鎖定版本與雜湊的 Pillow wheel。

這一節保留舊版的封存、索引及還原規格，供辨識歷史資料。截圖遮罩仍適用於目前的 Redmine 交付流程。腳本位於 `<skill 目錄>/scripts/`，輸出為 JSON。

| 用途 | Node.js 入口 |
|---|---|
| 登記、檢查及補套截圖遮罩 | `bdd.mjs mask-evidence` |
| 建立封存並登記索引 | `bdd.mjs archive` |
| 還原封存及別名 | `bdd.mjs extract` |
| 查詢、匯入及標記封存 | `bdd.mjs archive-index` |
| 重新壓縮既有封存 | `bdd.mjs recompress` |
| 預覽或執行證據清理 | `bdd.mjs prune` |

## 三層儲存

以下三層均保存每輪執行結果；Git 另存模組規格與共用設定，不提交本輪報告、驗證或遮罩紀錄。見 [版控分工](version-control.md)。

| 層 | 位置 | 存什麼 | 生命週期 |
|----|------|--------|----------|
| 工作區 | `<worktree>/.bdd/<單號-主題>/` | `REPORT.md`、`verification.json`、`masking.json`、`evidence/`（模組情境在 `.bdd/modules/`，不在這裡） | 證據在封存並確認上傳後由 `bdd.mjs prune` 清掉；報告保留 |
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
| `archiveRoot` | 本機封存庫根目錄，必須是絕對路徑，可用 `~` 開頭 | 依序看 `--archive-root` 參數、環境變數 `BDD_ARCHIVE_ROOT`，最後用預設位置 |
| `maxAttachmentBytes` | issue 附件大小上限（Redmine 預設 5 MB，以站台設定為準） | 不檢查 |
| `webp` | `auto`：有支援 WebP 的 Python Pillow 就把截圖轉成無損 WebP；`off`：不轉 | `auto` |
| `mask.required` | 圖片沒有有效遮罩登記就拒絕封存 | `true` |
| `mask.selectors` | 截圖前要遮蓋的元素（CSS 選擇器） | 由當次判斷畫面上的個資元素 |
| `mask.rects` | 事後依座標塗色的規則，`rect` 為 `[左, 上, 右, 下]` 像素 | 無 |

設定檔先找本 worktree 的 `.bdd/config.json`，沒有再找主 checkout 的。提交時只保留無敏感資料的團隊共用設定，個人路徑改用參數或環境變數；見 [版控分工](version-control.md)。

## 遮罩：在截圖當下處理

目的是讓未遮罩的原圖**從來不落地**，整個流程只產生一份可外傳的證據，不再有「原檔＋遮罩版」兩個封存。

1. **截圖時套用遮罩**。先建立本輪 `evidence/`，並在受測 worktree 的 `.bdd/config.json` 設定 `mask.selectors`。從該 worktree 使用實際操作畫面的具名 CLI session。隔離測試先完成[路由探測](worktree-loopback.md#啟動專用-cli-工作階段)。

   ```sh
   node "<skill 目錄>/scripts/bdd.mjs" cli-screenshot --session "<本輪 session 名稱>" --filename ".bdd/123-結帳/evidence/R2_IC-05_結帳結果.png" --target "#checkout-result"
   ```

   至少一個遮罩 selector 匹配可見元素才會存檔。以 `--target <CSS 選擇器>` 截取指定區塊，省略時截取 viewport，或加 `--full-page` 截取整頁。預設使用 CSS 像素，可用 `--scale device` 保存裝置解析度。若 CLI 不在 PATH，可指定 `--cli-path "<playwright-cli.js 絕對路徑>"`。支援的格式為 PNG 及 WebP，座標補遮罩時使用 PNG，每份證據使用新的檔名。若特定頁面缺少適用的共用 selector，可在本輪已驗證的 session 用原生 `run-code` 於截圖當下套用遮罩。以下 CSS 須換成該頁所有需遮蓋的欄位，檔名換成本輪尚不存在的證據絕對路徑（Windows 使用 `/`）。

   ```sh
   playwright-cli -s="<本輪 session 名稱>" run-code "async page => {
     const fields = page.locator('.account-email:visible, .contact-phone:visible');
     if (await fields.count() === 0) throw Error('找不到可見的遮罩欄位');
     await page.screenshot({ path: '<本輪 evidence 絕對路徑>/R2_IC-05_結帳結果.png', mask: [fields], maskColor: '#000' });
   }"
   ```

   逐張確認實際遮罩範圍後，以 `--method css` 登記。若已確認整個畫面沒有個資，可用同一個 `playwright-cli -s=<名稱> screenshot --filename="<本輪證據絕對路徑>.png"` 另存新檔，按下列方式登記豁免。
2. **登記**：截圖確認已遮罩後，登記到 `masking.json`（記錄當下的 SHA-256，之後檔案被改動就會失效）：
   ```bash
   node "<skill 目錄>/scripts/bdd.mjs" mask-evidence --dir <輸出資料夾> --mark --pattern 'R2_*' --method css
   ```
   畫面本來就沒有個資（例如登入前頁面、純 API 回應截圖）時用 `--method exempt --note '<理由>'`，理由必填。
3. **補救**：在 Windows 上，已經存在的未遮罩截圖可用 `mask.rects` 規則塗色並自動登記：
   ```bash
   node "<skill 目錄>/scripts/bdd.mjs" mask-evidence --dir <輸出資料夾> --apply
   ```
4. **檢查**：`node "<skill 目錄>/scripts/bdd.mjs" mask-evidence --dir <輸出資料夾> --status` 列出每張圖是 `masked`、`unmasked` 或 `stale`（登記後又被改）。上傳 issue 與封存前都要是全部 `masked`。

不要用 exempt 規避遮罩；看不出畫面有沒有個資時，當作有。

## 封存

### 執行前：核對 issue 交付

合併收尾在執行下列封存命令前，必須先完成 [整合與封存](closeout.md)〈7-1〉的 issue 更新。主代理重新讀取對應 issue，逐項核對修正註記、最後一輪截圖的附件識別／連結與可讀性，並確認對應本輪受測 SHA、情境與結果；純 API／DB 項目以已交付的替代證據核對。將核對結果與來源寫入報告〈issue 交付核對〉。本機檔案路徑、可貼上的草稿、上傳成功回應或只有 ZIP 附件，都不能代替此核對。

主代理將從 issue 回讀的實際註記和附件或替代證據交獨立子代理執行「Issue 回覆內容審核」。最終交付取得 `PASS` 後才依[服務停止](closeout.md#服務停止)與證據清理條件收尾。註記、附件、回讀或審核仍有缺漏時，保留本輪服務、`evidence/`、報告、驗證紀錄及 worktree，補正後重新回讀並送審。交付阻塞時回報待處理項目，暫停最終封存、`bdd.mjs prune --apply` 與 worktree 移除。

使用者明確只要報告／本機封存，或要求遷移舊資料時，依該限定範圍處理並記錄不適用原因；不擴張成 issue 更新或自動移除 worktree 的授權。進行中的交付不得套用舊資料遷移的 `--allow-local-only` 例外。

`bdd.mjs archive` 檢查本機內容，`bdd.mjs prune` 檢查封存涵蓋；兩者均不查詢 issue，無法強制上述交付關卡，須由主代理執行。`uploaded-verified` 只證明 ZIP 附件已確認可下載，不證明修正註記與逐項截圖已交付。

```bash
node "<skill 目錄>/scripts/bdd.mjs" archive --dir <最終 .bdd/單號-主題>
```

腳本依序：

1. 檢查 `REPORT.md`、`verification.json` 與證據都在、沒有符號連結；情境來自輸出資料夾的 `.feature`（舊格式）或 `verification.json` 最後一輪的 `scenarios`，兩者都沒有就停止。
2. **攤平**：舊輪次的 `evidence.zip` 解回 `evidence/`；同名同內容略過，同名不同內容就停止。`evidence.zip` 本身不收入封存。
3. **遮罩檢查**：每張圖片都要有有效的遮罩登記，否則列出缺漏的檔案並停止。
4. **情境快照**：依 `scenarios` 從受測 commit 取出當時的 `.feature`，放在 ZIP 的 `features/<模組路徑>/`。紀錄的 blob 與受測 commit 不符，或受測時情境未提交，就停止。
5. **轉無損 WebP**：只有 `evidence/` 內有 PNG／JPG／BMP 時才偵測 Pillow。轉成無損 WebP 後，解碼回來逐像素比對一致且檔案變小才採用，其餘保留原檔並記在 manifest 的 `webp.skipped`。ZIP 內的 `masking.json` 改以 `.webp` 登記（保留 `derivedFrom`），`.md` 檔裡的截圖連結改成 `.webp`；工作區的原檔都不動。有待轉圖片但找不到 Pillow 時，保留原格式並記錄 `webpUnavailable`。
6. **去重**：內容相同的檔案只存一份，其餘記在 `bdd-manifest.json` 的 `aliases`。
7. 打包成暫存檔，逐檔核對 SHA-256 後才搬到封存庫；任何失敗都不留半成品。
8. 在 `index.jsonl` 追加 `created`。同 repo、同單號及同主題的下一份封存會取代前一份。分組封存以組別為主題，每張單的同名組別各自保留有效的版本。

讀取舊索引時，若建立紀錄可證明自動取代事件把兩張不同單號的封存連在一起，會略過該事件，依其餘紀錄還原狀態與附件。手動標記與單號無從判定的歷史取代仍按原紀錄處理。

受測 SHA 預設取 `verification.json` 最後一輪的 `head`。單號取主題目錄名稱開頭的數字，分組目錄 `.bdd/<單號>-<主題>/groups/<組別>` 則從上層主題目錄取得。必要時可用 `--commit`、`--issue` 明確指定。輸出的 `exceedsAttachmentLimit` 為 true 時，上傳前要拆分，或 issue 只附最後一輪截圖，並註明完整封存只留本機。

ZIP 內第一層是輸出資料夾名稱，`bdd-manifest.json` 記錄每個檔案的 SHA-256、大小、aliases、受測 commit、是否已遮罩。只用系統內建解壓縮也能看到報告與所有不重複的截圖；要完整還原（含 aliases）用：

```bash
node "<skill 目錄>/scripts/bdd.mjs" extract --archive <zip> --to <repo>/.bdd
```

還原時不覆蓋既有檔案（同內容略過、不同內容停止），也不解出 manifest，所以還原後的資料夾可以直接接續下一輪並再次封存。

封存或重新壓縮時，若圖片轉成 WebP，封存內的 `coordination/attempt-<N>/result.json` 也會同步更新逐情境的 `evidence` 路徑。還原早期封存後，若結果仍引用已轉檔的原圖，彙總會核對 `masking.json` 的 `derivedFrom` 與 WebP 實際雜湊，再採用對應圖片。

若遮罩或封存程序意外中止，後續寫入可能提示 `masking.json.lock` 或 `index.jsonl.lock` 仍被占用。先確認同一輸出資料夾或封存庫的寫入程序已結束，再將殘留鎖檔移到封存來源以外留存。遮罩可用 `--status` 核對圖片，封存則比對目標 ZIP 的 SHA-256 與索引的 `created` 紀錄後再重試。

## 重新壓縮既有封存

1.3.0 以前的封存（或封存時沒有 Pillow）截圖仍是 PNG，可以事後轉成無損 WebP：

```bash
node "<skill 目錄>/scripts/bdd.mjs" recompress --archive <zip>
```

路徑與檔名不變，索引追加 `recompressed` 事件，狀態（例如 `uploaded-verified`）不變。issue 上的附件仍是原本的 PNG 版，那是正式紀錄，不重新上傳；索引以 `issueCopySha256` 記錄那一版的 SHA-256。`bdd.mjs prune` 以 manifest 的 `originalSha256` 比對工作區原圖，所以重新壓縮後仍可據以清理。

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
node "<skill 目錄>/scripts/bdd.mjs" archive-index --mark --archive <zip> --status uploaded-verified --attachment <附件 ID 或網址>
node "<skill 目錄>/scripts/bdd.mjs" archive-index --list --repo . --issue <單號>
```

## 清理工作區證據

先重新核對上述〈執行前：核對 issue 交付〉，即使既有 ZIP 已是 `uploaded-verified` 也不能略過。預設合併收尾須同時滿足 issue 交付核對與下列封存涵蓋條件，才能套用清理計畫；不能僅憑腳本回傳 `prune` 就刪除。

```bash
node "<skill 目錄>/scripts/bdd.mjs" prune --repo <worktree 或主 checkout>          # 只列計畫
node "<skill 目錄>/scripts/bdd.mjs" prune --repo <worktree 或主 checkout> --apply   # 實際刪除
```

清理工具核對同一 repo、同主題且已登記為 `uploaded-verified` 的 ZIP，讀取封存中的實際內容並驗證 SHA-256。只有 `evidence/` 每個檔案與 `evidence.zip` 每個項目的內容都有對應副本，才可清理。對匯入後轉成 WebP 的原圖，還須有本工具逐像素驗證後寫入索引的來源雜湊。舊匯入缺少該紀錄時，保留無法以相同內容核對的原圖。

報告、情境、遮罩紀錄與 Git 已追蹤的證據均保留。結果為 `keep` 時，依 `reason` 核對原因。如果清理中斷並留下 `.bdd-prune-*` 暫存目錄，先確認程序已結束，再核對其中的 `evidence/`、`evidence.zip` 與原路徑，保留兩邊仍需復原的檔案。

## 遷移舊資料（使用者要求搬移時）

舊版留下的資料分兩種，處理方式不同：

1. **舊版封存 ZIP**（例如主 checkout 的 `.claude/bdd-archives/*.zip`，沒有 manifest）：原檔匯入封存庫的 `<單號>/legacy/`，不重新打包，SHA-256 不變；issue 上有同一個檔案時，再登記 `uploaded-verified`。
   ```bash
   node "<skill 目錄>/scripts/bdd.mjs" archive-index --import --archive <舊 zip> --repo . --issue <單號> --topic <輸出資料夾名> --commit <短 SHA> --note "<來源說明>" --move
   ```
2. **工作區的 `.bdd/<單號-主題>/`**（含 `evidence/` 或 `evidence.zip`）：照一般流程封存。舊截圖沒有遮罩登記，而且不會上傳時，用 `--allow-unmasked-reason "<理由>"` 明確放行，manifest 會記下未遮罩清單與理由；這種封存**不可上傳 issue**。之後用 `bdd.mjs prune --allow-local-only` 清理工作區證據，清完後本機封存庫就是唯一的完整副本。

進行中的單（功能分支還沒併回、還會再跑下一輪的）不要遷移。

## 測試

```bash
node --test "<skill 目錄>/tests/archive-esm.test.mjs" "<skill 目錄>/tests/archive-index.test.mjs" "<skill 目錄>/tests/archive-images.test.mjs" "<skill 目錄>/tests/extract.test.mjs" "<skill 目錄>/tests/prune.test.mjs" "<skill 目錄>/tests/recompress.test.mjs"
```
