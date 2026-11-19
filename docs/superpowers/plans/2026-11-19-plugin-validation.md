# Plugin validation implementation plan

Goal: unify temporary-port policy, run verification on PRs, and reject invalid kit configuration before execution.

Scope: preserve existing staged work and plugin runtime's dependency-free installation. No database or product BDD execution is needed.

- [x] Add failing configuration-load tests for valid examples, legacy settings, invalid types, unknown keys, required fields, bounds, and CLI failure before snippet output.
- [x] Generate a standalone Ajv 2020-12 validator from config.schema.json using a pinned development dependency; validate on load with safe file/instance-path diagnostics. Check generated output freshness in CI.
- [x] Update eval #36 to use allocator-provided temporary ports; retain explicitly requested fixed-port behavior and add a fixed-port conflict case.
- [x] Enable pull_request verification in the existing workflow; keep tag ancestry checks and publishing tag-only; check manifest consistency on PRs too.
- [x] Run Node regression, Pester, allocator/contract checks, generated-validator freshness, and diff checks; report environmental limitations separately.

Verification so far: configuration tests first failed (14 failures, 2 passes), then all 16 passed. Full Node regression: 35/35 passed outside sandbox; sandbox loopback access produced EACCES. Generated validator freshness and standalone execution without require passed. Parallel contracts, quality plan, worktree MCP, cross-repo slot allocation, gitignore, and service cleanup checks passed. YAML structure and manifest consistency checks passed. Independent read-only review found no new correctness/regression issues.

Pester initial run: local Pillow 11.3 is below the required 13.0; 98 passed, 2 failed, 21 skipped. Final run with hash-verified Pillow 13.0 in ignored .test-tools/venv: **121 passed, 0 failed, 0 skipped** (199.08 seconds). XML: .test-tools/pester-results.xml. No global Python changes. GitHub-hosted PR execution has not been triggered; workflow YAML/conditions were checked locally.
