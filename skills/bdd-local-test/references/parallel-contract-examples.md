# 並行 BDD 契約範例

主代理建立組別模板或 v3 核准清單時使用派工輸入與核准清單範例。已收到派工的實測組依需要選讀結果或停止確認範例。以下的路徑、SHA、資源與確認依據均須替換為本輪實際值。

## 派工輸入

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "agent": "bdd_schedule_ui",
  "instructions": ["C:/skills/bdd-local-test/references/parallel-worker.md", "C:/repos/app/.bdd/5410-schedule/REPORT.md"],
  "requirements": [{"source": "issue:5410", "text": "列表顯示需求指定的賽制名稱"}],
  "scenarios": [{"feature": ".bdd/modules/organizer/schedule-settings/list.feature", "id": "SS-13", "kind": "changed"}],
  "target": {
    "repo": "C:/repos/app",
    "workDir": "C:/repos/app",
    "head": "1111111111111111111111111111111111111111",
    "dirtyPaths": [],
    "serviceVersion": "build-5410-1"
  },
  "environment": {
    "uiUrl": "http://localhost:4200",
    "apiUrl": "http://localhost:5000",
    "databaseTarget": "(localdb)\\MSSQLLocalDB / App_Test",
    "writeAuthorized": true,
    "confirmationBasis": "使用者於本任務對話明確回覆：確認上述 App_Test 與本輪資料讀寫範圍，可以測試；詳見 REPORT.md 資料庫環境確認，本輪已核對設定未變"
  },
  "resources": [{"id": "api-5410", "type": "service", "owner": "main", "access": "shared-read"}, {"id": "race-group-ui", "type": "data", "owner": "schedule-ui", "access": "exclusive-write"}],
  "browser": {"tool": "playwright-cli", "isolationId": "schedule-ui-browser", "chromiumArg": null},
  "account": {"role": "organizer", "credentialRef": "專案指定的本機測試帳密來源"},
  "dataScope": ["race-group-ui"],
  "permissions": {"editablePaths": [], "manageServiceIds": [], "externalActions": []},
  "dependsOn": [],
  "outputDir": "C:/repos/app/.bdd/5410-schedule/groups/schedule-ui"
}
```

## 結果輸出

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "taskStatus": "completed",
  "verification": {"path": "verification.json", "roundIndex": 0},
  "execution": {"tool": "playwright-cli", "uiUrl": "http://localhost:4200", "apiUrl": "http://localhost:5000", "serviceVersion": "build-5410-1"},
  "scenarios": [{
    "feature": ".bdd/modules/organizer/schedule-settings/list.feature",
    "id": "SS-13",
    "kind": "changed",
    "status": "passed",
    "expected": "列表顯示指定的賽制名稱",
    "actual": "真實登入後列表顯示指定名稱",
    "reason": null,
    "evidence": ["REPORT.md#ss-13"]
  }],
  "artifacts": {"report": "REPORT.md", "masking": "masking.json"},
  "modifiedPaths": [],
  "blockers": [],
  "rerunScenarios": [],
  "resourceStates": [{"id": "api-5410", "released": true}, {"id": "race-group-ui", "released": true}]
}
```

## 停止確認

```json
{
  "contractVersion": 1,
  "runId": "5410-schedule-R1",
  "groupId": "schedule-ui",
  "attempt": 1,
  "requestId": "pause-login-fix-1",
  "resources": [{"id": "api-5410", "released": true}],
  "testProcessesStopped": true,
  "savedResult": "coordination/attempt-1/result.json",
  "reason": "已保存當輪證據並停止使用共用 API"
}
```

## 核准清單

```json
{
  "contractVersion": 3,
  "scope": "batch",
  "selections": [{
    "path": "C:/reports/5410/R1/quality-plan.json",
    "sha256": "abababababababababababababababababababababababababababababababab"
  }],
  "runId": "5410-schedule-R1",
  "groups": [{
    "groupId": "schedule-ui",
    "repo": "C:/repos/app",
    "revision": {
      "head": "1111111111111111111111111111111111111111",
      "dirtySha256": null
    },
    "scenarios": [{
      "feature": ".bdd/modules/organizer/schedule-settings/list.feature",
      "id": "SS-13",
      "kind": "changed",
      "assertions": [{
        "requirement": "#5410 驗收第 1 條，列表顯示賽制名稱",
        "action": "以主辦方身分開啟已設定賽制的賽程列表",
        "expected": "該場賽事顯示已設定的賽制名稱",
        "method": "UI，核對主辦方在列表實際看到的文字",
        "evidence": "保留含該賽事與名稱的遮罩截圖"
      }]
    }]
  }]
}
```
