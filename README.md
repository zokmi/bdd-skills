# BDD Skills

[English](README.md) · [繁體中文](README.zh-TW.md)

A Claude Code and Codex plugin for writing Traditional Chinese Gherkin scenarios and verifying them locally.

## Install

**Claude Code 2.1.275+** · Run in an interactive session.

```text
/plugin install bdd-skills --marketplace zokmi/bdd-skills
```

**Codex** · Run in a terminal.

```sh
codex plugin marketplace add zokmi/bdd-skills
codex plugin add bdd-skills@zokmi-bdd-skills
```

## Prerequisites

- Git and Node.js for module checks, quality plans, verification records, and parallel test summaries. Run these commands through `skills/bdd-local-test/scripts/bdd.mjs`.
- On Windows, the Node.js CLI also allocates worktree IPs, prepares isolated MCP sessions, and stops verified worktree processes. It compiles a small helper with the Windows .NET Framework C# compiler for native file locks and process inspection.
- Use `bdd.mjs mask-evidence` to register and check screenshot masks, `bdd.mjs archive` to create ZIPs, and `bdd.mjs extract` to restore them. The ZIP runtime ships with the plugin. Applying rectangle masks to existing images uses Windows System.Drawing.
- Use `bdd.mjs archive-index` to list, import, or mark archives, `bdd.mjs recompress` to convert archived screenshots, and `bdd.mjs prune` to preview evidence cleanup. Pass `--apply` to carry out a verified cleanup plan. Existing PowerShell commands forward to the Node.js CLI.
- A connected Playwright MCP session for UI tests and subagent support for live BDD runs.
- Import the built-in routing and API tools as ES modules on Node.js 18.2+. For existing scripts that use `require()`, see the [test kit migration notes](skills/bdd-local-test/references/test-kit.md). Install `mssql` in the project under test when using the bundled SQL Server tool. Lossless WebP archive conversion requires Python with Pillow 13.0.0+ and WebP support.

## Features

- Maintain Traditional Chinese Gherkin scenarios by module for UI, external APIs, events, and scheduled jobs.
- Verify real UI, API, and database behavior locally. Isolate worktrees and retain traceable reports and redacted evidence.
- Independently audit scenario scope, verifiability, requirements coverage, and format.

## Skills

- [`bdd-local-test`](skills/bdd-local-test/SKILL.md) — Write acceptance scenarios, coordinate local verification and retests, and produce an evidence-backed report.
- [`bdd-scenario-audit`](skills/bdd-scenario-audit/SKILL.md) — Review scenario documents in read-only mode and report findings with their locations and suggested fixes.
- [`bdd-issue-reply-audit`](skills/bdd-issue-reply-audit/SKILL.md) — Verify the published issue reply and its attachments against the changes and BDD results before stopping services or asking how to handle the branch.
