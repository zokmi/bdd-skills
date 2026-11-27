# 精簡選測計畫

- **需要閱讀全部明細**時，在原有 `quality-plan` 命令加 `--compact`。省略的 Feature `reason` 沿用計畫的 `reason`。有 `tags` 的情境依原順序取符合 `^@[A-Z]{2,3}-\d{2,}$` 的標籤為 `ids`、取 `@UI`、`@API`、`@DB` 為 `methods`，兩者去掉開頭的 `@` 並保留重複項。未附在情境上的編號及需核對全文的標記都保留。現有完整 JSON 呼叫方式仍適用。
- **只需分工或抽查**時，加 `--preview-output "<新檔路徑>"`，放在已存在的 Git 忽略目錄或工作區外。工具寫入完整原始計畫並回傳 `previewPath`、檔案 SHA-256、HEAD、閘門、狀態、計數及 Feature 路徑。先看 `bddStatus` 和 `staticPassed`，檢查 lint、未映射路徑及阻塞數量。即使 exit 0 且有選入情境，仍可能是 `BLOCKED`。`indexedScenarios` 只計已列出的情境，`requiresFullFeature` 中每個檔案都須讀取全文。

使用回執的路徑與 SHA 查閱預覽。指定 `features` 中的路徑只印該 Feature；省略 `--feature` 則印狀態、lint、未映射路徑與阻塞原因。

```sh
node "<skill 目錄>/scripts/bdd.mjs" quality-plan --read-preview "<預覽檔>" --sha256 "<sha256>" --feature "<Feature 路徑>"
```

批次核准派工使用 `--issue`、`--run-id`、`--output` 建立含候選版本驗證的選測檔。`--compact` 與 `--preview-output` 只供閱讀計畫。
