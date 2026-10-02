# 報告與驗證紀錄

### 7. 產出 REPORT.md 並清理

依 [報告範本](../assets/REPORT-template.md) 寫 `REPORT.md`。報告的讀者可能是 PM 或沒參與開發的同事，
所以摘要寫業務語言，技術細節放在各情境段落。
在〈環境〉與〈修正與複測〉註明實際使用的瀏覽器工具、localhost 網址、每輪修正與複測結果。

**報告必須註記 git commit**：標題表格的「repo」「測試版本」寫完整資訊，〈版本紀錄〉逐輪列出 repo、分支、受測 HEAD（短 SHA）、
工作區是否乾淨與結果統計，〈受測 commit〉列出本輪涵蓋的每個 commit（短 SHA＋標題）。
測的是含未提交異動的工作區時照實寫「`<SHA>` + 未提交異動（檔案…）」，不要只寫 SHA 讓人以為測的是乾淨版本。
同步後複測的輪次，另填〈同步對照〉：來源 repo／commit → 本 repo 對應 commit 與對應方式（`patch`／`subject`／`missing`）。

報告寫完後，**每一輪都要記錄驗證紀錄**（沒跑完、有失敗也要記，結果統計照實填）：

```bash
pwsh -NoProfile -File "<skill 目錄>/scripts/bdd-verification.ps1" -Record -Dir <輸出資料夾>   -Base <基準分支> -Passed N -Failed N -Blocked N -NotRun N   -ChangedScenarios "<本單新增或修改的 .feature，多個以 ; 分隔>"   -RegressionScenarios "<回歸的 .feature>::<編號>,<編號>"   -Note "<一句話，例如：自 yuanlih 同步後複測>"
```

`-ChangedScenarios`／`-RegressionScenarios` 每項是「`<repo 相對路徑>`」（取檔內全部情境）或「`<路徑>::<編號>,<編號>`」；多項以 `;` 分隔，整串加引號。
情境檔要先 commit：封存時會從受測 commit 取出當時那一版放進 ZIP，受測時未提交的情境會讓封存失敗。

範圍不是 `<基準>..HEAD`（例如使用者指定了 commit、或在別的分支上 cherry-pick 過來的一串）時，
改用 `-Commits <sha1>,<sha2>` 明列。`verification.json` 與 `REPORT.md` 一樣要保留；若專案允許，跟著進版控，
程式同步到別處時它也一起過去。若 `.bdd/` 被忽略，不要私自強制加入；至少把報告與修正後截圖附到 issue，並註明版本紀錄只留在本機與 issue。記錄前工作區若有受測檔案的未提交異動，腳本會記在 `dirtyPaths`，
之後的比對一律判 `rerun`——所以正式結案的那一輪，應在受測異動都 commit 之後再跑。
