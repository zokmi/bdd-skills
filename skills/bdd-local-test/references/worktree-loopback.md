# 在 git worktree 裡測：用 loopback IP 分流

本文件適用 `scripts/loopback-slot.ps1` 回傳 `isolated=true` 的工作區：worktree 自動隔離；多專案的主 checkout 明確加 `-Isolate`。必須先完成 `SKILL.md` 第 5 節的 preflight，才啟動或沿用本輪服務。

多專案同時使用相同 port 時使用同一使用者的 `%USERPROFILE%/.bdd-loopback/registry-v1/` 共用登記與檔案鎖，在服務啟動前預約不同 IP；不使用可能因 sandbox 而不同的 TEMP。`preflight.registryPath` 必須指向相同登記檔。`BDD_LOOPBACK_REGISTRY_DIR` 僅供隔離測試 fixture 覆寫；正式多專案不可各自設成不同目錄。不同使用者、未使用此分配器的服務及綁全部 IP 的程序仍須核對占用；沒有共用登記存取權時先處理權限，不降級為 repo 私有分配。無法取得隔離 IP 時列為阻塞。其他工作區的服務維持運作。

## 啟動契約：隔離 IP 與本輪有效埠

啟動前在報告逐服務填寫：`repo/worktree → 原始 localhost URL（含協定與 port）→ 本輪實際監聽 port → 設定來源 → 本輪綁定 IP → 完整啟動命令（遮罩秘密）`。前端 dev-server port、API port、HTTPS port 與 proxy 的 upstream port 分別查證；以專案文件、生效 profile／環境覆寫及啟動日誌核對，不能套用文件中的示例數字。無法確認實際 port 時先阻塞。

原埠可用時沿用，被占用時自動分配臨時埠。`portMappings` 列出每個 `originalPort` 與 `effectivePort`，`effectivePorts` 供本輪啟動與清理，`occupied` 保留原埠占用證據。要求固定埠或已確認沿用本工作區原埠服務時，加 `-KeepOriginalPorts`。同一工作區的測試輪次序列執行。

執行順序：確認資料庫授權與上述啟動契約 → 檢查分配 IP／原 port 占用 → 以臨時參數啟動本輪前後端服務 → 核對實際監聽 IP／port、PID、工作區與版本 → 啟動帶 `chromiumArg` 的獨立 MCP Chrome／Chromium → 導覽本輪 localhost URL，驗證 UI 與真實 API 請求。

此處「Chrome 導轉」指獨立瀏覽器程序的 `--host-resolver-rules` localhost 對應；它不會啟動 API、不改寫 port，也不是 HTTP 重新導向或假 API 回應。服務須由上述命令另行啟動；若使用既有啟動／導轉服務，先查證其真實命令、路由與程序歸屬，仍須滿足相同契約，不臆造工具。

多個隔離工作區同時實測時，各自綁一個 `127.0.0.N`，使用本輪有效埠。腳本第一次分配 slot，之後重用；worktree 的 slot 隨 Git 目錄移除，下次分配會清除失效登記。既有 slot 與其他 repo 登記衝突時停止，不偷偷換 IP；先確認並停止原服務，再受控清除失效 slot，重新 preflight。

前端換埠時使用有效埠導覽，並確認 API 接受本輪前端 Origin。API 換埠時，以本輪程序參數或環境覆寫前端 API URL、dev-server proxy、SSR 與直接 API 測試的目標。無法覆寫硬編碼網址或 Origin 限制時，將相關情境列為阻塞。維持專案設定檔、系統 hosts 及全域代理原狀。

## 臨時 MCP 設定與連線

在該 worktree 根目錄執行，埠號取自專案文件：

```powershell
pwsh -NoProfile -File "<skill 目錄>/scripts/prepare-worktree-mcp.ps1" -Ports <原埠號，逗號分隔> -OutputDir <本輪輸出目錄>/mcp
```

回傳 preflight、原 ports、portMappings、effectivePorts、唯一 isolationId、configPath 與 stdio MCP 的 server.command／server.args。產生器只寫本輪臨時檔，不啟動瀏覽器、不變更專案或全域 MCP 設定；`status=configuration-only` 不代表已連線或可測。將完整回傳 JSON 保存到本輪輸出目錄，作為唯一對應。若啟動時被其他程序搶占或工具自行換埠，停止本輪已啟動的自有服務，重新準備並更新全部啟動參數與測試網址，最多重試兩次。仍無法綁定時列為阻塞。

多專案主 checkout 在上述命令與 `loopback-slot.ps1` 加 `-Isolate`，同樣綁回傳 IP／有效埠 並使用 MCP resolver。未加時維持原 localhost 解析（可能是 IPv6），不代表已隔離；多專案同 port 不可直接沿用此模式。清理明確隔離的主 checkout 時，`stop-slot-services.ps1` 也加 `-Isolate`，仍只停止路徑歸屬符合的自有程序；未加時一律不停止主 checkout 服務。

啟動描述使用 `npx --offline --no-install @playwright/mcp@latest --config <路徑>`，重用與 Codex 預設 Playwright MCP 相同的 npm 快取鍵。找不到套件時，可用下方的 `--mcp-cli` 指定已安裝版本。

核對本輪實際目標後，可依 [登入自動化](authentication.md) 選擇已對應的私有狀態檔，再以 `-StorageState <檔案>` 產生設定。回傳的 MCP 參數會帶入 `--storage-state`；每個 session 仍以獨立 context 啟動。未指定時從乾淨狀態開始。

1. 核對 preflight.occupied 的程序歸屬，依下節臨時啟動本輪服務。
2. 在每個 worktree／同時執行組別啟動下方的 [專用 MCP 工作階段](#啟動專用-mcp-工作階段)，傳入本輪準備結果 JSON。入口以回傳的 `--config` 建立獨立 stdio MCP server，並自動用同一條連線完成路由探測。若客戶端已支援任務範圍的獨立 MCP 連線，也可使用回傳的 command／args 建立，並執行下方的手動探測。
3. 記錄實際終端 session ID 或客戶端工具前綴、`configPath`、`isolationId` 和探測結果。UI 操作只送到本輪已驗證的連線。
4. 若啟動或探測失敗，排查命令、MCP 版本、終端權限和本機路由，再以本輪設定重新建立連線。未通過探測時將相關 UI 情境列為阻塞。
5. 探測通過後，以同一 MCP 的 browser_navigate 開啟`http(s)://localhost:<有效埠>`。使用瀏覽器網路資訊、服務存取紀錄／程序資訊及版本端點等證據，確認前端與 API 的實際請求到達分配 IP、有效埠與該 worktree 版本。不能只看網址或首頁成功。無法確認任一層則阻塞；HTTPS、代理或 Host 檢查問題須排查，不修改專案或全域安全設定繞過。
   Chromium 的 resolver 僅影響瀏覽器，不影響 dev-server proxy、SSR 或後端程序自己發出的 localhost 請求。須逐一追查這些程序間連線的實際目標與版本；僅可使用該程序支援的本輪臨時環境變數／啟動參數導向所屬 worktree IP／有效埠。無此能力則相關情境阻塞，不修改原設定檔，也不把瀏覽器前端導轉成功當成 API 隔離成功。
6. 同時測兩個 worktree 前，確認兩個 MCP 瀏覽器的登入／儲存狀態互不影響，前端與 API 版本皆正確。核對專案相關檔案的前後 diff，確認沒有因導轉改動 localhost／埠號。
7. 符合[服務停止](closeout.md#服務停止)的全部收尾條件後，由管理者向本輪終端入口送出 `{"tool":"close"}`，或關閉本輪客戶端連線。確認 MCP 與瀏覽器關閉後，再停止本輪服務。臨時設定在使用程序停止後清理，不停止其他 worktree 或使用者原服務，也不刪除共用分配鎖檔。

共用 session 只能序列測試，切換 worktree 前仍須關閉舊瀏覽器並以新設定重新建立及驗證連線；僅換分頁不會更新 localhost 對應。獨立連線不可得時，可繼續獨立的 API／DB 範圍，不宣稱 UI 通過。

### 啟動專用 MCP 工作階段

在支援持久 stdin 的終端以 Node.js 18.2 以上啟動：

```powershell
node "<skill 目錄>/scripts/bdd.cjs" mcp-session "<本輪準備結果 JSON>"
```

在 Codex 使用可寫入 stdin 的終端（`exec_command` 設 `tty: true`，後續用 `write_stdin` 向同一 session ID 送一行 JSON 並按 Enter）。如果終端沙箱拒絕 loopback 或 Chrome 啟動，使用平台提供的本機執行授權後重試。若已安裝的 MCP 位於獨立工具目錄，附加 `--mcp-cli "<已安裝的 @playwright/mcp/cli.js>"`。

看到 `status=ready` 後才開始操作。保留其中 `probe` 的 `status=matched`、`isolationId`、`ip` 與 `port` 作為路由證據。每次送一行，等相同 `id` 的 `result` 或 `error` 後再送下一個操作：

```jsonl
{"id":1,"tool":"tools/list"}
{"id":2,"tool":"browser_navigate","args":{"url":"http://localhost:<前端有效埠>/"}}
{"id":3,"tool":"browser_snapshot"}
{"tool":"close"}
```

同一個入口可依序執行多個情境及 MCP 工具呼叫。結束時送出 `close` 並確認程序退出。切換 worktree 或需要重啟瀏覽器時，重新啟動入口，等新一輪探測成功。

### 手動驗證 MCP 的 localhost 路由

用 Node.js 18.2 以上啟動探測器，傳入本輪準備腳本回傳的完整 JSON 檔：

```powershell
node "<skill 目錄>/scripts/bdd.cjs" mcp-probe "<本輪準備結果 JSON>"
```

探測器只綁本輪分配的 IP，由系統選擇臨時埠。看到 `status=ready` 後，在 60 秒內用將要執行 UI 測試的 MCP `browser_navigate` 開啟回傳的完整 `url`。保留瀏覽器回應與探測器輸出，兩邊都須有 `status=matched`，且 `isolationId`、`ip`、`port` 與 `ready` 相符。探測器收到符合本輪隨機路徑及 localhost Host 的 GET 後關閉，逾時則以非零狀態退出。

Chrome 的 `chrome://version` 可協助診斷啟動旗標。實際路由以探測器收到的請求為準。MCP 重連、瀏覽器重啟或切換 worktree 後重新探測。

## 服務與 slot

slot 分配先取得跨 repo 的共用登記鎖，再取得共用 Git 目錄的鎖，避免服務尚未監聽時跨專案同時分到同一 IP。既有 slot 重複、無效或與登記不一致時停止，不在服務可能仍運作時自動換 IP。分配鎖不代表服務、帳號或資料已隔離。

1. 從專案文件確認本輪所有前後端原埠號，在受測 repo 根目錄執行：
   ```bash
   pwsh -NoProfile -File "<skill 目錄>/scripts/loopback-slot.ps1" -Ports <專案用到的埠，逗號分隔>
   ```
   保存 JSON 的 `slot`、`ip`、`chromiumArg`、`occupied`。以 MCP 準備腳本回傳的本輪對應為準。
2. 按 `occupied` 的位址、埠號、PID 確認原埠占用者。另起服務時使用分配的有效埠。指定固定埠且無法沿用服務時列為阻塞。
3. 服務只綁腳本給的 `ip`，使用本輪有效埠。例如：
   - ASP.NET Core：`ASPNETCORE_ENVIRONMENT=Development dotnet run --project <Api 專案> --no-launch-profile --urls http://<ip>:<有效埠>`。IIS Express 無法綁 `127.0.0.N` 時改用 Kestrel。
   - Angular：`npx ng serve --host <ip> --port <有效埠> [原本的 --ssl／--configuration]`。
   - 其他框架用其指定監聽位址的參數，不修改專案設定檔。
4. 啟動後用該 `ip` 和有效埠檢查前後端 HTTP 回應與本輪版本；僅有監聽程序或首頁可連不足以證明正在測本輪程式。重建或重啟後再查一次。
5. `@UI` 使用已套用 `chromiumArg` 的獨立 MCP session，以有效埠導覽並核對 API 的實際目標。MCP 無法提供隔離或無法確認實際目標時，相關 UI 情境列為阻塞。
6. `@API`／`curl` 直接打 `http://<ip>:<埠>`。若後端需驗 Origin，帶 `-H "Origin: http://localhost:<前端埠>"`。
7. 報告〈環境〉記錄 `isWorktree=true`、slot、IP、原埠與有效埠、占用判定、實際 UI／API 網址及受測版本的確認方式。共用資料庫不會因 IP 分流而隔離；測試資料使用 `BDD-<單號>-` 前綴並盡量選不同建案或主檔，避免互相干擾。

全通過後依 `SKILL.md` 第 7 節的停止腳本清理本 worktree 服務；`develop` 推送、issue 更新與最終 BDD 封存確認後，依〈7-3〉安全移除本輪 worktree。有失敗或阻塞時保留供複測。不可清理其他 worktree 或使用者的服務。
