# 模組情境集

情境照**功能模組**持續維護，證據照 **issue** 封存。這份說明模組怎麼切、MODULE.md 怎麼寫、編號與撞號怎麼處理。

## 為什麼分兩層

| | 證據（截圖、REPORT.md、verification.json） | 情境（.feature） |
|---|---|---|
| 性質 | 某個 commit 當下的驗證快照，結案後不再改 | 功能「現在應該怎樣」，隨需求演進 |
| 放哪裡 | `.bdd/<單號>-<主題>/` | `.bdd/modules/<portal>/<主路由>/` |

同一個模組被多張單修改時，後一張單**修改模組裡的情境**，不另寫一份。issue 層只留本輪的結果與證據，`verification.json` 記錄跑了哪些模組情境。

模組 `.feature` 與 `MODULE.md` 進 Git；issue 層全部輸出由本機及完整封存保存，不提交。忽略規則與既有資料遷移見 [版控分工](version-control.md)。

## 模組怎麼切

- 預設 **portal＋主路由**，例如 `organizer/schedule-settings`、`organizer/matches`、`member/ad-cooperation`；排程程式用 `job/<程式名>`。
- 共用元件、全站樣式的外溢情境放 **shared 模組**：`<portal>/shared/<元件名>`，例如 `organizer/shared/category-tabs`。
- 一個模組一個目錄，目錄內一份 `MODULE.md` 與若干 `NN-<英文主題>.feature`。不要在模組目錄底下再開子模組。

## MODULE.md

```markdown
---
prefix: SS
paths:
  - Project/frontend/organizer-portal/src/app/pages/schedule-settings/**
  - Project/backend/EventPlatform.BLL/Services/ScheduleSettingService.cs
issues:
  - 5349
  - 5354
removed:
  - SS-07 #5400 需求取消，改由賽程結果頁處理
---

# organizer/schedule-settings 賽制管理

- 入口：organizer-portal 賽程管理 > 賽制管理（/race/:raceId/schedule-settings/:divisionId）
- 範圍：賽制列表、組別賽制編輯、儲存列
```

| 欄位 | 說明 |
|------|------|
| `prefix` | 2–3 個大寫英文字母，整個 repo 內唯一 |
| `paths` | 對應程式路徑（glob，`**` 跨目錄）；`bdd-modules.ps1 -Base` 依此從異動檔案找出模組 |
| `issues` | 新增或修改過本模組情境的單號 |
| `removed` | 已刪除的編號：`<編號> #<單號> <原因>`；這些編號不可再用 |

front matter 之後的正文寫給人看：入口、範圍、注意事項。

## 編號

- 模組內流水號，新增的用 `bdd-modules.ps1 -NextId -Module <模組>` 取得（現有與已移除的最大號加一）。
- 用過的號碼不重用；刪除情境時在 `removed` 記一行。
- 修改既有情境的預期：改在原地，補上本單的單號標籤，例如 `@SS-03 @#5349 @#5410 @UI`。
- 每個情境要有：一個編號、至少一個單號標籤、至少一個 `@UI`／`@API`／`@DB`。

## 檢查

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-modules.ps1" -Lint
```

有問題時 exit 1 並列出：編號重複、前綴重複、編號前綴不符、缺單號或驗證手段標籤、用回已移除的編號、情境檔所在目錄沒有 MODULE.md、MODULE.md 格式錯誤。在〈3-1〉送審前與〈7-1〉合併後各跑一次，**有問題不進入執行、不推 develop**。

## 並行分支撞號

兩條分支都從 develop 開出、都新增了 `SS-13`：

1. 〈7-1〉把功能分支合併進最新的 `origin/develop` 時處理。
2. 合併衝突**全部**落在 `.bdd/modules/` 底下時，自行解：`.feature` 兩邊的情境都保留，本分支新增的情境改用 `-NextId` 取得的新號；`MODULE.md` 的 `issues`、`removed` 取聯集。只要同時有任何 `.bdd/modules/` 以外的檔案衝突，整個合併就照現行規則停下來回報，連 `.bdd/modules/` 的衝突也先不動。
3. 沒有文字衝突、但 `-Lint` 報 `duplicate-id` 時，同樣把本分支新增的改號。
4. 改號寫進 REPORT〈情境修訂〉（例如「`SS-13`→`SS-15`（與 #5401 撞號）」）；合併後重跑那一輪的證據用新編號，舊輪次證據保留原檔名。

## 遷移舊資料（使用者要求時）

舊版每張單的 `.feature` 放在 issue 資料夾裡。整併到模組的步驟：

1. 列出對照表給使用者確認：每個舊情境 → 模組、新編號、合併／保留／刪除與理由。內容重複或矛盾要語意判斷，不靠腳本。
2. 確認後寫進 `.bdd/modules/`，整批依〈3-1〉送子代理審核，並通過 `-Lint`。
3. 刪除 issue 資料夾裡的 `.feature`（git 歷史與封存都還在），舊 REPORT.md 與 verification.json 不動。
4. 新增 `.bdd/modules/MIGRATION-<年>-<月>.md`，記錄舊編號 → 新編號。

進行中的單（功能分支還沒併回）不要遷移。
