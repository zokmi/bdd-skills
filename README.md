# BDD Skills

[English](README.md) · [繁體中文](README.zh-TW.md)

A Traditional Chinese BDD testing plugin for Claude Code and Codex. It helps teams turn requirements into verifiable Gherkin acceptance scenarios, run them locally through real UI, API, and database paths, and retain traceable reports and evidence.

## About the plugin

`bdd-skills` bundles `bdd-local-test` for maintaining business scenarios by module, running and rerunning local tests, and saving evidence. It also includes `bdd-scenario-audit` for read-only checks of scenario scope, verifiability, requirements coverage, and format. When the agent workflow adds or changes scenario files, an independent subagent checks compliance. This check can share an assignment with an existing scenario audit. The check runs within the agent workflow.

## What's included

- Scenario scope covers observable business behavior a module promises to users or external actors, including success and failure paths for UI interactions, external APIs, events, and scheduled jobs. Record technical checks and evidence separately for engineering changes such as refactors, deployment configuration, and SQL migrations. Full verification still covers the relevant engineering risks.
- `skills/bdd-local-test/SKILL.md` turns feature changes into Traditional Chinese Gherkin scenarios, runs local verification, and produces reports.
- `skills/bdd-scenario-audit/SKILL.md` uses an independent read-only subagent to identify issues in existing scenarios and report their locations, the applicable rules, and suggested fixes. Product test results require a separate test run. In Claude Code, use `/bdd-skills:bdd-scenario-audit`. In Codex, ask for the `bdd-scenario-audit` skill.
- `assets/`, `references/`, and `scripts/` contain report templates, writing guides, and local verification utilities.
- `evals/` defines skill evaluation cases.
- `tests/` contains Pester tests for archiving, redaction, and cleanup scripts (`pwsh -NoProfile -Command "Invoke-Pester -Path skills/bdd-local-test/tests"`).
- The worktree and MCP configuration regression check (`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-WorktreeMcp.ps1`) covers concurrent allocation across four processes, slot reuse, independent MCP configuration, reuse of original ports, and temporary port assignment when a port is busy. Run product UI BDD separately.
- The cross-project allocation regression check (`pwsh -NoProfile -File skills/bdd-local-test/tests/Test-CrossRepoSlot.ps1`) uses real temporary Git repositories and worktrees to test concurrent first-time allocation, IP reuse, and rejection of conflicting legacy slots.
- The live Chrome network routing check uses `pwsh -NoProfile -File skills/bdd-local-test/tests/Test-LoopbackLive.ps1 -McpCli <installed @playwright/mcp/cli.js> -ChromePath <chrome.exe> -OutputDir <evidence directory> -UseDefaultRegistry`. It creates two temporary projects, four worktrees, and two isolated main checkouts. Six independent headless Chrome and stdio MCP sessions each pass the localhost routing probe, then verify UI and API HTTP identity, destination IP, Origin, and storage isolation concurrently. The shared defaults are UI port 4200 and API port 9453. If either is busy, specify test ports with `-UiPort` and `-ApiPort`. The test saves evidence in `result.json` and each group's `probe-evidence.json`. Install Chrome and Playwright MCP beforehand, and ensure you can create temporary Git directories and start local services. Omit `-UseDefaultRegistry` to use the fixture's dedicated registry.

Run local UI scenarios against localhost through a connected Playwright MCP session. Fix any product defects, restart the service, and rerun the tests. Troubleshoot the connection or worktree isolation first if Playwright MCP is unavailable. If it still cannot run, mark the affected UI scenarios as blocked. Playwright MCP is required for these scenarios. Run scenarios sequentially when they share an MCP session.

Maintain scenarios by feature module in `.bdd/modules/` and keep each issue's results and required delivery evidence scoped to the current run. Assign subagents first to select the issue's BDD scope, then to prepare the verification checklist. An independent subagent reviews the scenarios and checklist before test assignments begin. After execution, an independent subagent reviews the report and evidence against the approved checklist. Update the issue after the report and consistency review pass. Redact, register, and retain screenshots according to the checklist. Use screenshots from the final verification round for issue delivery and remove temporary agent screenshots after inspection. [Module maintenance](skills/bdd-local-test/references/modules.md) · [Scenario review](skills/bdd-local-test/references/scenario-review.md)

After worktree development and related regression checks pass, ask the user whether to convert the worktree to a feature branch or merge the changes back into `develop`, unless they already chose. Keep the workspace as it is until they choose. A scenarios-only or report-only task skips the delivery choice. Stop the current worktree services and test browsers as soon as all BDD tests pass, local results and required evidence are saved, screenshot review passes or is marked inapplicable, and all test agents release their resources. This cleanup can proceed while issue updates, uploads, delivery choices, or archiving are pending.

For feature-branch delivery, run the full BDD suite in the feature worktree before confirming the branch name and converting it. Keep the worktree and required delivery evidence. A rename with the same revision and environment uses the existing test results. For delivery into `develop`, run tests for the fix and relevant regressions during development, then run full verification once on the latest integrated `develop` before pushing. After pushing that revision, check the remote SHA, update the issue, and attach the required evidence from the final verification round. Read back the Redmine attachments before removing local screenshots. Keep non-image reports and clean up the current worktree after merge delivery. [Archive verification and retention](skills/bdd-local-test/references/archive.md)

## BDD version control and delivery

For a specified issue, the lead agent reads the applicable issue-writing skill and verification-completion template after the final full BDD run passes and the consistency review returns `PASS`. Use the template's reply format, title, field order, and placement for the fix and verification notes. Upload the final round's redacted screenshots or API or database evidence required by the issue, then read the issue back to verify the note and attachments. Both feature-branch and merge-to-`develop` delivery include the issue update. For the merge workflow, push and verify the remote SHA first. Follow any explicit scope restriction on scenarios, reports, or issue updates. Changing issue status or closing an issue requires separate authorization. If there is no unique issue, permission is insufficient, review fails, or an upload fails, retain the required evidence and report BDD and issue delivery status separately. The feature worktree stays in place after the issue update. [Shared issue delivery](skills/bdd-local-test/references/closeout.md#共用-issue-交付最終完整驗證後自動執行)

Verify the core change and its prerequisites first in each round. For a specified issue, finish the core checks before assigning the rest of that issue's acceptance tests. If issue updates are authorized and related tests are still pending, a dedicated subagent updates the issue and reads it back once its results pass review. Assign the remaining related tests afterward. A dedicated subagent also handles final delivery. [Issue verification and updates](skills/bdd-local-test/references/execution-workflow.md#issue-優先驗證與回寫)

Save approved screenshots under the run's `evidence/` directory. Delete temporary agent screenshots after inspection. Remove local copies of required issue screenshots once Redmine confirms they are readable. If an upload fails, keep the images needed for the retry.

Before running any UI, API, or database test, show the actual database host or instance, database name, environment, configuration source, and read/write scope, then wait for the user's explicit confirmation. This applies to local and read-only scenarios. A notice or a request to keep testing until everything passes does not count as confirmation. Hold testing and test-agent assignments pending confirmation. Reuse confirmation for reruns with the same target and scope. Confirm again when either changes or testing moves to another repository, and record the basis in the report.

At the start of each BDD run, the skill calls its internal CLI to verify and complete the target project's ignore rules while retaining module scenarios and shared configuration. Repeated runs avoid duplicate rules, report conflicts, and list existing tracked artifacts for follow-up.

Each project or worktree uses its own loopback IP. Reuse the original ports where available. If a port is busy, `prepare-worktree-mcp.ps1` assigns a port for the current run. Startup, testing, and cleanup share the same port mapping, preserving the original project configuration, system hosts file, and global proxy settings. Set up independent MCP connections before running UI tests in parallel, then verify the frontend and API destinations and versions. [Worktree isolation](skills/bdd-local-test/references/worktree-loopback.md)

For scenarios that require authentication, reuse the login state for the same environment, account, and role while it is valid. If it expires, use the project's configured test login. For manual steps such as MFA, save the state for reuse after verifying the login. [BDD test login](skills/bdd-local-test/references/authentication.md)

The [dedicated MCP session](skills/bdd-local-test/references/worktree-loopback.md#啟動專用-mcp-工作階段) for isolated UI testing automatically loads the current run's configuration, verifies localhost routing, and invokes Playwright MCP tools sequentially over one connection. Omit `-McpCli` from the Chrome regression check to test the plugin's default offline npm launch path.

Tag business impact with `@P0`, `@P1`, or `@P2`. Determine required checks based on whether the change is a feature, bug fix, security change, data migration, or engineering change. For a small issue with a well-defined impact, use TARGETED to cover affected P0 and `@core` cases, issue scenarios, and required regressions. Before execution, an independent subagent checks the list against the acceptance criteria and diff. [Scenario priorities and required coverage](skills/bdd-local-test/references/scenario-priority.md) · [Quality gate](skills/bdd-local-test/references/quality-gate.md)

Test subagents execute every BDD run. The lead agent reviews the scope, groups tests, assigns and monitors work, and compiles results. Assign a subagent even for a single group. With multiple groups, schedule batches or parallel runs based on environment isolation and available agent slots. Run groups sequentially when their services or data cannot be isolated. Mark execution as blocked if subagents are unavailable or the user explicitly disables them. Record the execution mode, agents, and assignment contracts in the report. Scenario review and test execution use separate assignments. The lead agent checks each group's evidence, revision, and scenario coverage. Run full verification on the final integrated revision. The structured contract provides three JSON Schemas and a read-only summarizer that produces `summary.json` and `SUMMARY.md`. [Parallel BDD with subagents](skills/bdd-local-test/references/parallel-bdd.md) · [Structured contract](skills/bdd-local-test/references/parallel-bdd-contract.md)

Track scenarios and `MODULE.md` under `.bdd/modules/`, along with `.bdd/config.json` when it contains no sensitive or personal settings. Keep each run's reports, verification and redaction records, delivery screenshots, logs, and browser profile under `.bdd/<issue>-<topic>/` outside Git. Keep non-image records locally and required issue screenshots in Redmine after confirming delivery. Other approved screenshots stay local. Remove temporary agent screenshots after inspection. Close out the run without a separate report-only commit and keep the existing output paths. [Ignore rules, tracked data migration, and worktree recovery](skills/bdd-local-test/references/version-control.md)

## Install in Claude Code

In an interactive session on Claude Code 2.1.275 or later, add the marketplace and install the plugin with one command.

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

When adding the marketplace for the first time, confirm the prompt and choose the installation scope. After installation, use `/bdd-skills:bdd-local-test`.

If the plugin is already installed, update the marketplace and plugin from a terminal, then restart Claude Code to load the new version.

```text
claude plugin marketplace update zokmi-bdd-skills
claude plugin update bdd-skills@zokmi-bdd-skills
```

## Install in Codex

Run these commands in a terminal.

```text
codex plugin marketplace add zokmi/bdd-skills
codex plugin add bdd-skills@zokmi-bdd-skills
```

After installation, use the `bdd-local-test` skill in Codex.

Before running tests, review the target project's instructions and environment configuration, and follow the confirmation workflow in `SKILL.md`.

## License

This project is licensed under the [Apache License 2.0](LICENSE) (`Apache-2.0`).

## Plugin development checks

Pull requests and version tags share the Node.js checks across platforms, Windows Pester tests, assignment contract checks, and worktree regression tests in `.github/workflows/release.yml`. Version tags also publish a release. Install locked development dependencies with `npm ci --ignore-scripts`, then run `npm test` and `npm run check:config-validator`. When changing the configuration schema, run `npm run generate:config-validator` and commit the generated validator with the change. CI rejects stale output. Ajv generates the validator, and the plugin runs without an npm installation. See `skills/bdd-local-test/scripts/lib/config-validator.LICENSE.txt` for the MIT license of the components included in the generated code.

## Migrate from a custom BDD kit

1. Move hard-coded frontend and API ports, the API prefix, login fields, and token paths into each project's `.bdd/config.json`. [Configuration schema and examples](skills/bdd-local-test/schemas/config.schema.json)
2. Replace the localhost router or relay with the bundled `route-snippet.cjs` or `routeLocalhostToSlot`. If the worktree uses different ports, pass the current `prepare-worktree-mcp.ps1` result to `--prepared`.
3. Replace custom API calls with `createApi().call` and use the configured profile's `login`. Supply credentials via parameters or environment variables and store the token in the run's system temporary directory. Remove any global `NODE_TLS_REJECT_UNAUTHORIZED` override.
4. For SQL Server, enable `kit.database`, configure the connection string source, and supply `mssql` from the project under test. Replace calls with `createDb().run`, `query`, or `holdAppLock`. Keep project-specific SQL and other extensions in the project's test source directory.
5. Run an isolated verification round. Check that requests reach the current run's services, query results are correct, and evidence contains no credentials. Then remove the replaced custom scripts. [Test kit guide](skills/bdd-local-test/references/test-kit.md)

## README translations

Update this English README on `main`. The Translate README workflow generates and commits `README.zh-TW.md` when this file changes. You can also regenerate the translation from the repository's Actions tab.
