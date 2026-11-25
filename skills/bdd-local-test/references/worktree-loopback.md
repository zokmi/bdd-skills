# 在 git worktree 裡測：用 loopback IP 分流

本文件適用 `node scripts/bdd.mjs loopback-slot` 回傳 `isolated=true` 的工作區：worktree 自動隔離；多專案的主 checkout 明確加 `--isolate`。必須先完成 `SKILL.md` 第 5 節的 preflight，才啟動或沿用本輪服務。

多專案同時使用相同 port 時使用同一使用者的 `%USERPROFILE%/.bdd-loopback/registry-v1/` 共用登記與檔案鎖，在服務啟動前預約不同 IP；不使用可能因 sandbox 而不同的 TEMP。`preflight.registryPath` 必須指向相同登記檔。`BDD_LOOPBACK_REGISTRY_DIR` 僅供隔離測試 fixture 覆寫；正式多專案不可各自設成不同目錄。不同使用者、未使用此分配器的服務及綁全部 IP 的程序仍須核對占用；沒有共用登記存取權時先處理權限，不降級為 repo 私有分配。無法取得隔離 IP 時列為阻塞。其他工作區的服務維持運作。

## 啟動契約：隔離 IP 與本輪有效埠

啟動前在報告逐服務填寫：`repo/worktree → 原始 localhost URL（含協定與 port）→ 本輪實際監聽 port → 設定來源 → 本輪綁定 IP → 完整啟動命令（遮罩秘密）`。前端 dev-server port、API port、HTTPS port 與 proxy 的 upstream port 分別查證；以專案文件、生效 profile／環境覆寫及啟動日誌核對，不能套用文件中的示例數字。無法確認實際 port 時先阻塞。

原埠可用時沿用，被占用時自動分配臨時埠。`portMappings` 列出每個 `originalPort` 與 `effectivePort`，`effectivePorts` 供本輪啟動與清理，`occupied` 保留原埠占用證據。要求固定埠或已確認沿用本工作區原埠服務時，加 `--keep-original-ports`。同一工作區的測試輪次序列執行。

確認資料庫授權與上述啟動契約後，先檢查分配 IP 與原埠占用，以臨時參數啟動本輪所需服務，再核對實際監聽 IP、埠、PID、工作區及版本。純 API 組直接呼叫該 IP 與有效埠，保存實際請求結果。需要 UI 操作的組另外啟動帶 `chromiumArg` 的具名 CLI session，完成路由探測後導覽應用頁面，驗證 UI 與真實 API 請求。

此處「Chrome 導轉」指獨立瀏覽器程序的 `--host-resolver-rules` localhost 對應；它不會啟動 API、不改寫 port，也不是 HTTP 重新導向或假 API 回應。服務須由上述命令另行啟動；若使用既有啟動／導轉服務，先查證其真實命令、路由與程序歸屬，仍須滿足相同契約，不臆造工具。

多個隔離工作區同時實測時，各自綁一個 `127.0.0.N`，使用本輪有效埠。腳本第一次分配 slot，之後重用；worktree 的 slot 隨 Git 目錄移除，下次分配會清除失效登記。既有 slot 與其他 repo 登記衝突時停止，不偷偷換 IP；先確認並停止原服務，再受控清除失效 slot，重新 preflight。

前端換埠時使用有效埠導覽，並確認 API 接受本輪前端 Origin。API 換埠時，以本輪程序參數或環境覆寫前端 API URL、dev-server proxy、SSR 與直接 API 測試的目標。無法覆寫硬編碼網址或 Origin 限制時，將相關情境列為阻塞。維持專案設定檔、系統 hosts 及全域代理原狀。

## 準備 Playwright CLI 設定

從受測 worktree 根目錄執行。將原埠清單與本輪輸出目錄換成實際值。PowerShell 範例把完整準備結果保存成 JSON，後續啟動、轉送與清理均以這份對應為準。若從舊版 Playwright MCP 流程升級，請在本輪以新的暫存目錄重新產生 CLI 的 `prepared.json`，再核對服務、session 與路由。

```powershell
$bdd = "<skill 目錄>/scripts/bdd.mjs"
$runDir = ".bdd/.playwright-cli/<本輪-組別>"
$prepared = node $bdd prepare-worktree-cli --ports "<原埠號，逗號分隔>" --output-dir $runDir
if ($LASTEXITCODE -ne 0) { throw "瀏覽器隔離設定建立失敗" }
$manifest = Join-Path $runDir "prepared.json"
$prepared | Set-Content -Encoding utf8 -LiteralPath $manifest
```

從回傳的 `preflight` 核對原埠占用與程序歸屬，依 `portMappings` 和 `effectivePorts` 啟動本輪服務。回傳的 `configPath` 指向含 `chromiumArg` 的臨時 CLI 設定，`isolationId` 是本輪的 session 名稱。CLI 自動產生的 snapshot 和日誌存入此組暫存目錄，可能含畫面個資，請與本輪報告、遮罩證據和封存來源分開。`status=configuration-only` 時仍待啟動與探測。若服務啟動時埠被搶占或自行換埠，停止本輪已啟動的自有服務，重新準備並更新全部啟動參數與測試網址，最多重試兩次。仍無法綁定時列為阻塞。

多專案主 checkout 在上述指令及 `loopback-slot` 加 `--isolate`，清理時 `stop-slot-services` 也加 `--isolate`。單一主 checkout 使用原 localhost 解析（可能是 IPv6）。若 `playwright-cli` 不在 PATH，可在準備命令加 `--cli-path "<@playwright/cli 的 playwright-cli.js 絕對路徑>"`；後續直接操作瀏覽器時，以 `node "<同一 playwright-cli.js>"` 取代命令中的 `playwright-cli`。需要沿用已驗證的登入時，依[登入自動化](authentication.md)選擇私有狀態檔，並加 `--storage-state "<檔案>"`。

### 啟動專用 CLI 工作階段

服務已綁在本輪 IP 與有效埠、已核對監聽程序與版本後，從同一 worktree 執行：

```powershell
node $bdd cli-session $manifest
```

入口開啟具名瀏覽器，從該 session 導覽探測網址，確認導覽成功，並核對探測器收到本輪請求。指定登入狀態檔時，探測成功後才載入。命令返回時保留已驗證的瀏覽器；記下 `status=ready`、`session`、`probe.status=matched`、`isolationId`、IP 與探測埠。啟動或探測失敗時，核對 CLI 與瀏覽器安裝、執行權限、設定及本機路由，修正後重試。無法驗證路由則將相關 UI 情境列為阻塞，可獨立執行的 API／DB 繼續。

從同一工作目錄執行後續命令，每次都傳入同一個 session 名稱。若情境需要[瀏覽器 HTTP(S) 轉送](test-kit.md#瀏覽器-localhost-轉送)，先執行該片段，再導覽受測網址。

```powershell
$uiSession = ($prepared | ConvertFrom-Json).isolationId
playwright-cli -s=$uiSession goto "http://localhost:<前端有效埠>/"
playwright-cli -s=$uiSession snapshot
```

依專案實際協定導覽。以服務存取紀錄、程序資訊、版本端點及瀏覽器網路請求核對前端與 API 到達的 IP、有效埠與版本。Chromium resolver 只作用於瀏覽器，dev-server proxy、SSR 或後端程序發出的請求另以本輪啟動參數／環境覆寫指向所屬服務。任何一層無法核對時，將相關情境列為阻塞。記錄本輪設定檔路徑與驗證結果，並以專案檔案的前後 diff 核對原始設定。

並行 UI 組各自使用具名 session，先驗證彼此的登入與儲存狀態獨立。若多組共用本輪同一個已確認版本的服務與埠對應，可複製本輪 CLI 設定、保留 resolver，將各組 `outputDir` 設為各自暫存目錄的絕對路徑。各組以不同的 `-s=<組別唯一名稱>` 執行 `open --config="<該組設定檔>"`，並為每個實際操作的 session 分別完成下方探測。共用 session 時依序操作；切換 worktree 或重啟瀏覽器後，重新以該 worktree 的設定開啟並探測。

符合[服務停止條件](closeout.md#服務停止)時，由管理者以 `playwright-cli -s=<名稱> close` 關閉本輪具名 session，確認關閉後再停止本輪自有服務。臨時設定在使用程序退出後清理，保留共用分配鎖檔。

### 手動驗證 CLI session 的 localhost 路由

在一個終端執行 `node $bdd cli-probe $manifest`。探測器只綁本輪分配的 IP，由系統選擇臨時埠。看到 `status=ready` 後，在 60 秒內從同一 worktree 的另一個終端，以即將實測的 `playwright-cli -s=<名稱> goto "<ready.url>"` 導覽。用 `playwright-cli -s=<名稱> snapshot` 核對頁面的 JSON，並比對探測器收到的 `status=matched`、`isolationId`、`ip`、`port`。兩方須與本輪 `ready` 資訊相符。探測器在收到帶有本輪隨機路徑及 localhost Host 的 GET 後關閉，逾時以非零狀態退出。

## 服務與 slot

Windows CLI 透過隨插件提供的 C# 原始碼存取系統檔案鎖、TCP 監聽表與程序身分。每個需要這些功能的 Node 程序會使用 Windows .NET Framework 編譯器建立暫存執行檔，正常退出後清理。新舊入口共用相同的 registry、slot 檔與鎖定順序。

若 Windows 或執行沙箱拒絕讀取 TCP 監聽表，preflight 會中止。請在能讀取該主機監聽資訊的環境重跑，確認既有監聽者後再啟動服務。

slot 分配先取得跨 repo 的共用登記鎖，再取得共用 Git 目錄的鎖，避免服務尚未監聽時跨專案同時分到同一 IP。既有 slot 重複、無效或與登記不一致時停止，不在服務可能仍運作時自動換 IP。分配鎖不代表服務、帳號或資料已隔離。

1. 從專案文件確認本輪所有前後端原埠號，在受測 repo 根目錄執行：
   ```bash
   node "<skill 目錄>/scripts/bdd.mjs" loopback-slot --ports "<專案用到的埠，逗號分隔>"
   ```
   保存 JSON 的 `slot`、`ip`、`chromiumArg`、`occupied`。以 CLI 準備腳本回傳的本輪對應為準。
2. 按 `occupied` 的位址、埠號、PID 確認原埠占用者。另起服務時使用分配的有效埠。指定固定埠且無法沿用服務時列為阻塞。
3. 服務只綁腳本給的 `ip`，使用本輪有效埠。例如：
   - ASP.NET Core：`ASPNETCORE_ENVIRONMENT=Development dotnet run --project <Api 專案> --no-launch-profile --urls http://<ip>:<有效埠>`。IIS Express 無法綁 `127.0.0.N` 時改用 Kestrel。
   - Angular：`npx ng serve --host <ip> --port <有效埠> [原本的 --ssl／--configuration]`。
   - 其他框架用其指定監聽位址的參數，不修改專案設定檔。
4. 啟動後用該 `ip` 和有效埠檢查前後端 HTTP 回應與本輪版本；僅有監聽程序或首頁可連不足以證明正在測本輪程式。重建或重啟後再查一次。
5. `@UI` 使用已套用 `chromiumArg` 的具名 CLI session，以有效埠導覽並核對 API 的實際目標。無法驗證 session 隔離或無法確認實際目標時，相關 UI 情境列為阻塞。
6. `@API`／`curl` 直接打 `http://<ip>:<埠>`。若後端需驗 Origin，帶 `-H "Origin: http://localhost:<前端埠>"`。
7. 報告〈環境〉記錄 `isWorktree=true`、slot、IP、原埠與有效埠、占用判定、實際 UI／API 網址及受測版本的確認方式。共用資料庫不會因 IP 分流而隔離；測試資料使用 `BDD-<單號>-` 前綴並盡量選不同建案或主檔，避免互相干擾。

全通過後依 `SKILL.md` 第 7 節的停止腳本清理本 worktree 服務；`develop` 推送、issue 更新與最終 BDD 封存確認後，依〈7-3〉安全移除本輪 worktree。有失敗或阻塞時保留供複測。不可清理其他 worktree 或使用者的服務。
