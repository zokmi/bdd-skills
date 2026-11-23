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

- Git and PowerShell 7 (`pwsh`) for the local scripts. Node.js 18.2+ for the built-in routing and API tools.
- A connected Playwright MCP session for UI tests and subagent support for live BDD runs.
- Install `mssql` in the project under test when using the bundled SQL Server tool. Lossless WebP archive conversion requires Python with Pillow 13.0.0+ and WebP support.

## Features

- Maintain Traditional Chinese Gherkin scenarios by module for UI, external APIs, events, and scheduled jobs.
- Verify real UI, API, and database behavior locally. Isolate worktrees and retain traceable reports and redacted evidence.
- Independently audit scenario scope, verifiability, requirements coverage, and format.

## Skills

- [`bdd-local-test`](skills/bdd-local-test/SKILL.md) — Write acceptance scenarios, coordinate local verification and retests, and produce an evidence-backed report.
- [`bdd-scenario-audit`](skills/bdd-scenario-audit/SKILL.md) — Review scenario documents in read-only mode and report findings with their locations and suggested fixes.
