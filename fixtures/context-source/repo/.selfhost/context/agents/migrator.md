---
name: migrator
description: Applies a database migration and opens a pull request with it.
tools: [Read, Edit, Bash, mcp__github__create_pull_request]
model: inherit
agents: [claude_code, codex, copilot, opencode]
---

Apply the migration you are given, run `pnpm db:check`, and open a pull request.
