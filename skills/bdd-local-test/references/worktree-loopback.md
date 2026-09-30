# 在 git worktree 裡測：用 loopback IP 分流

本文件只在 `scripts/loopback-slot.ps1` 回傳 `isWorktree=true` 時使用。必須先完成 `SKILL.md` 第 5 節的 preflight，才啟動或沿用本輪服務。

多個 worktree 同時實測時，各自綁一個 `127.0.0.N`，沿用專案原埠號，避免為了分流修改前端 API 位址、CORS 或專案設定。腳本第一次執行會分配 slot，之後重用；移除 worktree 時 slot 隨其 git 目錄釋放。

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
5. `@UI` 用隔離的 Node Playwright Chromium，啟動時傳入 `chromium.launch({ args: [chromiumArg] })`。`chromiumArg` 會將瀏覽器內的 `localhost` 對應到本 worktree IP，讓頁面及前端寫死的 `http://localhost:<埠>` API 呼叫都進入本輪服務；瀏覽器 Origin 仍是 `localhost:<埠>`。一般 Playwright MCP session 不能逐 worktree 設此參數，這條路徑不要改用共用 MCP session。專案未裝 playwright 時裝在 scratchpad，不改專案的 `package.json`。需要人工目視時可提供 JSON 的 `chromeCommand`，用獨立設定檔開 Chrome。
6. `@API`／`curl` 直接打 `http://<ip>:<埠>`。若後端需驗 Origin，帶 `-H "Origin: http://localhost:<前端埠>"`。
7. 報告〈環境〉記錄 `isWorktree=true`、slot、IP、原埠號、占用判定、實際 UI／API 網址及受測版本的確認方式。共用資料庫不會因 IP 分流而隔離；測試資料使用 `BDD-<單號>-` 前綴並盡量選不同建案或主檔，避免互相干擾。

全通過後依 `SKILL.md` 第 7 節的停止腳本清理本 worktree 服務；`develop` 推送、issue 更新與最終 BDD 封存確認後，依〈7-3〉安全移除本輪 worktree。有失敗或阻塞時保留供複測。不可清理其他 worktree 或使用者的服務。
