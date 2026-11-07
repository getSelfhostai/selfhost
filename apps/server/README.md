# @selfhost/server

The selfhost HTTP API. Today it serves `GET /v1/health`; the rest of the API is specified in
[`packages/schema/openapi.yaml`](../../packages/schema/openapi.yaml).

```sh
pnpm --filter @selfhost/server dev     # watch mode on http://127.0.0.1:4400
pnpm --filter @selfhost/server build   # bundles to dist/main.js
pnpm --filter @selfhost/server start   # runs the build
```

Environment: `PORT` (default 4400), `HOST` (default 127.0.0.1).
