# 內建實測工具

從受測 worktree 根目錄執行，使用插件的 scripts 絕對路徑。Node.js 18.2 以上可使用轉送和 API 工具。參考 [config.schema.json](../schemas/config.schema.json) 的 examples，以實際專案設定填入 .bdd/config.json 的 kit 欄位。既有的封存、遮罩與情境設定可照常使用。只提交埠、欄位名稱、環境變數名稱與可共用的相對路徑。

`loadKitConfig()` 在回傳設定前依 Schema 驗證整份 JSON；`kit` 內未知欄位、型別錯誤、缺必要欄位及越界值會直接中止，錯誤列出設定檔絕對路徑與 JSON Pointer，不輸出設定值。既有非 `kit` 頂層設定仍可保留。驗證器隨插件附帶，使用者無須安裝 npm 依賴。

## 瀏覽器 localhost 轉送

先完成 [worktree 隔離與路由探測](worktree-loopback.md)。從同一 worktree 執行：

```powershell
node "<skill>/scripts/route-snippet.cjs" --prepared "<本輪準備結果 JSON>"
```

將 stdout 當作同一個已驗證 MCP session 的 browser_run_code 的 code，再用 browser_navigate 導覽。原埠與有效埠相同時，也可用 node "<skill>/scripts/route-snippet.cjs" <slot IP>。前端與 API 埠各取自 kit.routing。驗證服務端確實收到了請求，並比對版本。

自有 Playwright 腳本從 scripts/lib/routing.cjs 匯入 routeLocalhostToSlot，呼叫 await routeLocalhostToSlot(context, { ...kit.routing, ip, portMappings })。ip 和 portMappings 取自本輪準備結果的 preflight.ip 與 portMappings。函式與 MCP 片段使用相同的 context route。重裝時更新同一 handler 的設定，保留註冊順序。空清單只解除安裝工具自己的 handler。若既有 context mock 與轉送匹配同一 URL，可使用 page.route，或在首次安裝轉送後註冊該 context mock 以取得優先序。

前端直接改寫目的位址，API 由 context.request 代送。HTTPS API 的憑證例外限於該次 slot 請求，代送不跟隨重新導向。轉送涵蓋 HTTP(S)，**不轉送 WebSocket（HMR）**。需要 HMR 時使用已驗證的瀏覽器 resolver。服務工作者攔截的請求也不會經過 Playwright route，受測情境需要時，以 serviceWorkers: 'block' 建立本輪 context 並確認這符合情境需求。

## API

```js
const { loadKitConfig } = require('<skill>/scripts/lib/kit-config.cjs');
const { createApi } = require('<skill>/scripts/api.cjs');
const kit = loadKitConfig();
const api = createApi({ ...kit.api, ip, portMappings, evidenceDir });
const login = await api.login('reader', 'primary'); // 使用 profile 的環境變數
if (!login.ok) throw new Error('Test login failed');
const response = await api.call('reader', 'GET', 'app:/example/resource');
api.saveEvidence('response-summary.json', { status: response.status, ms: response.ms });
```

數字埠預設 HTTPS。也可用 { port, protocol } 指定 HTTP。API 換埠時傳入本輪 portMappings，前綴簡寫會自動使用有效埠。完整 URL 直接使用指定的埠，因此應填本輪 IP 與有效埠。逾時預設 30 秒且涵蓋整個請求。匿名呼叫使用角色 none。login(role, profile, credentials) 的第三個參數可提供具名欄位，優先於環境變數。fields 將請求欄位對應到輸入名稱，env 以輸入名稱索引環境變數，tokenPath 依序列出回應 JSON 的路徑。登入只回傳狀態及成功與否。

預設每個 API 用戶端有獨立的系統暫存目錄。需跨腳本共用登入時，傳入本輪已建立的私有暫存子目錄 tokenDir，並在收尾刪除自有目錄。每個角色依序登入，避免多個用戶端同時寫同一個角色。只將已篩選的欄位交給 saveEvidence。它拒絕 JWT、Bearer 與敏感欄位的非空值，證據檔使用唯一檔名。直接回應的 body 和 raw 可能含憑證，禁止直接記入報告或日誌。

## SQL Server（選配）

設定 kit.database.enabled，並在受測專案的 Node 依賴中安裝 mssql（Strict 需支援 TDS 8.0 的 Tedious）。工具在第一次 DB 操作時，才從專案解析驅動。環境變數值優先。appsettings 清單由基礎到環境專屬，後出現的同名 ConnectionStrings 欄位覆寫前值。路徑相對 worktree 根目錄，檔案需為 JSON。SQL 驗證字串可用引號及雙引號跳脫，支援主機、具名執行個體和 TCP 埠。Encrypt 預設開啟並驗證憑證，Strict 保留 TDS 8.0 行為。

```js
const { createDb } = require('<skill>/scripts/db.cjs');
const db = createDb(kit.database);
const rows = await db.query('SELECT Status FROM dbo.Example WHERE Id = @id', { id: fixtureId });
```

run(sql) 回傳批次的全部結果集，query(sql, params) 回傳第一個結果集。holdAppLock(resource, holdMs) 回傳 { got, held, release }，以交易持有鎖。用 try/finally 呼叫 await lock.release()，逾時也會嘗試回收。仍須在啟動前確認資料庫授權及測試資料隔離，並使用參數綁定測試資料。
