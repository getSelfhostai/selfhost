---
description: Conventions for the HTTP API handlers
globs:
  - src/api/**/*.ts
  - "**/*.sql"
---

Every handler validates its input with the shared schema before it touches the database.
Return errors as `{ "error": "<message>" }` with a 4xx status.
