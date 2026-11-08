---
name: db-migrate
description: Writes and checks a database migration. Run it by name when a schema change is needed.
version: 0.3.0
allowed-tools: Read, Edit, Bash(pnpm db:*)
disable-model-invocation: true
---

Write the migration in `migrations/`, then run `pnpm db:check` and fix what it reports.
Never edit a migration that is already merged.
