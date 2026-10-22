# 在 git worktree 裡測：用 loopback IP 分流

本文件只在 `scripts/loopback-slot.ps1` 回傳 `isWorktree=true` 時使用。必須先完成 `SKILL.md` 第 5 節的 preflight，才啟動或沿用本輪服務。

多個 worktree 同時實測時，各自綁一個 `127.0.0.N`，沿用專案原埠號，避免為了分流修改前端 API 位址、CORS 或專案設定。腳本第一次執行會分配 slot，之後重用；移除 worktree 時 slot 隨其 git 目錄釋放。

**localhost 與原埠號不可異動**：不修改前端 API URL、環境檔、啟動設定、CORS、系統 hosts 或全域代理。僅以本輪程序的啟動參數綁定 worktree IP，在獨立 MCP Chromium 程序內暫時對應 localhost；結束程序即解除導轉。不可攔截或偽造 API 回應代替路由。原程式若寫死 `127.0.0.1`／`::1` 而非 localhost，或無法透過臨時參數綁定位址，先列為阻塞，不修改原設定或改埠繞過。

## 臨時 MCP 設定與連線

在該 worktree 根目錄執行，埠號取自專案文件：

```powershell
pwsh -NoProfile -File "<skill 目錄>/scripts/prepare-worktree-mcp.ps1" -Ports <原埠號，逗號分隔> -OutputDir <本輪輸出目錄>/mcp
```

回傳 preflight、原 ports、唯一 isolationId、configPath 與 stdio MCP 的 server.command／server.args。產生器只寫本輪臨時檔，不啟動瀏覽器、不變更專案或全域 MCP 設定；`status=configuration-only` 不代表已連線或可測。

啟動描述使用 `npx --no-install @playwright/mcp --config <路徑>`，不在測試時自動下載套件或變更專案依賴。找不到已安裝套件時先處理工具前置條件；不得移除限制後默默安裝或改用另一種測試工具。

1. 核對 preflight.occupied 的程序歸屬，依下節臨時啟動本輪服務。
2. 透過客戶端支援的任務範圍 MCP 連線方式，為每個 worktree／同時執行組別啟動獨立 stdio server，使用回傳的 command／args。`--config` 載入 `browser.isolated=true` 與 `browser.launchOptions.args` 的 localhost 對應；stdio 不新增專案服務埠。使用已安裝且確認支援這些欄位的 MCP 版本。格式見 [官方 MCP 文件](https://github.com/microsoft/playwright-mcp#configuration-file)。
3. 記錄實際 server／工具前綴、configPath 與 isolationId，操作只呼叫所屬連線的 MCP 工具。isolationId 只是協調標記；不同 chat、子代理或分頁也不是隔離證據。客戶端不能建立或識別獨立連線時，相關 UI 列為阻塞。
4. 以所屬 MCP 的 browser_navigate 開啟原 `http(s)://localhost:<原埠>`。使用瀏覽器網路資訊、服務存取紀錄／程序資訊及版本端點等證據，確認前端與 API 的實際請求到達分配 IP、原埠與該 worktree 版本。不能只看網址或首頁成功。無法確認任一層則阻塞；HTTPS、代理或 Host 檢查問題須排查，不修改專案或全域安全設定繞過。
   Chromium 的 resolver 僅影響瀏覽器，不影響 dev-server proxy、SSR 或後端程序自己發出的 localhost 請求。須逐一追查這些程序間連線的實際目標與版本；僅可使用該程序支援的本輪臨時環境變數／啟動參數導向所屬 worktree IP，沿用原埠。無此能力則相關情境阻塞，不修改原設定檔，也不把瀏覽器前端導轉成功當成 API 隔離成功。
5. 同時測兩個 worktree 前，確認兩個 MCP 瀏覽器的登入／儲存狀態互不影響，前端與 API 版本皆正確。核對專案相關檔案的前後 diff，確認沒有因導轉改動 localhost／埠號。
6. 結束時由管理者關閉本輪 MCP 瀏覽器與 server，再停止本輪服務。證據依既有流程保存；臨時設定在使用程序停止後清理，不停止其他 worktree 或使用者原服務，也不刪除共用分配鎖檔。

共用 session 只能序列測試，切換 worktree 前仍須關閉舊瀏覽器並以新設定重新建立及驗證連線；僅換分頁不會更新 localhost 對應。獨立連線不可得時，可繼續獨立的 API／DB 範圍，不宣稱 UI 通過。

## 服務與 slot

slot 分配以共用 Git 目錄的檔案鎖序列化。既有 slot 重複或無效時停止，不在服務可能仍運作時自動換 IP。分配鎖不代表服務、帳號或資料已隔離。

1. 從專案文件確認本輪所有前後端原埠號，在受測 repo 根目錄執行：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/loopback-slot.ps1" -Ports <專案用到的埠，逗號分隔>
   ```
   保存 JSON 的 `slot`、`ip`、`chromiumArg`、`occupied`。不要自行指定另一個 IP 或改埠號繞過占用。
2. `occupied` 不為空時，按 `address`、`port`、`pid` 查程序與工作目錄。若確定是本 worktree 的服務，可沿用，但仍要確認其建置版本含本輪異動。若屬於其他 worktree、使用者服務，或綁 `0.0.0.0`／`::` 而占住所有 IP，暫停並回報，不要停掉或借用它。無法確認歸屬時也不要當成自己的服務。
3. 服務只綁腳本給的 `ip`，使用專案原埠號。例如：
   - ASP.NET Core：`ASPNETCORE_ENVIRONMENT=Development dotnet run --project <Api 專案> --no-launch-profile --urls http://<ip>:<原埠>`。IIS Express 無法綁 `127.0.0.N` 時改用 Kestrel。
   - Angular：`npx ng serve --host <ip> --port <原埠> [原本的 --ssl／--configuration]`。
   - 其他框架用其指定監聽位址的參數，不修改專案設定檔。
4. 啟動後用該 `ip` 和原埠號檢查前後端 HTTP 回應與本輪版本；僅有監聽程序或首頁可連不足以證明正在測本輪程式。重建或重啟後再查一次。
5. `@UI` 必須使用隔離的 Playwright MCP session，透過 MCP 的瀏覽器啟動設定套用 `chromiumArg` 並確認生效。此參數讓瀏覽器內的 `localhost` 與前端寫死的 `http://localhost:<埠>` API 呼叫都對應到本 worktree IP，Origin 仍為 `localhost:<埠>`。先確認 MCP 實際支援的設定方式，不假設頁面腳本能修改啟動參數。MCP 無法配置參數、無法提供隔離 session 或無法確認請求進入本輪服務時，相關 UI 情境列「阻塞」，記錄限制與解除條件；不得改用 Node Playwright、CLI 或人工 Chrome 替代驗收。共用 session 只能序列使用，且仍須滿足本輪 loopback 隔離。
6. `@API`／`curl` 直接打 `http://<ip>:<埠>`。若後端需驗 Origin，帶 `-H "Origin: http://localhost:<前端埠>"`。
7. 報告〈環境〉記錄 `isWorktree=true`、slot、IP、原埠號、占用判定、實際 UI／API 網址及受測版本的確認方式。共用資料庫不會因 IP 分流而隔離；測試資料使用 `BDD-<單號>-` 前綴並盡量選不同建案或主檔，避免互相干擾。

全通過後依 `SKILL.md` 第 7 節的停止腳本清理本 worktree 服務；`develop` 推送、issue 更新與最終 BDD 封存確認後，依〈7-3〉安全移除本輪 worktree。有失敗或阻塞時保留供複測。不可清理其他 worktree 或使用者的服務。
