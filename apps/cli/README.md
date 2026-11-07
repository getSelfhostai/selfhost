# @selfhost/cli

The `selfhost` command line.

```sh
pnpm --filter @selfhost/cli dev --version
pnpm --filter @selfhost/cli dev doctor [--config path/to/selfhost.toml]
pnpm --filter @selfhost/cli dev spend --since 7d --by request_type,model
```

`selfhost spend [--since 7d] [--by request_type,model] [--threshold 10] [--min-usd 0] [--json]`
reads `cost.recorded` events from the ledger (the same one `selfhost import` writes, or
`--database` / `--data-dir`), keeps one source per session, and prints spend per group with its
share, then every request type that crossed `--threshold` percent of a day's spend, with the day
it crossed and the days before. `--by` takes `request_type`, `agent`, `model` and `person`; flags
are always by request type. See [`packages/spend`](../../packages/spend/README.md).

`selfhost doctor` prints the runtime, finds `selfhost.toml` (the `--config` flag, then
`SELFHOST_CONFIG`, then the nearest file from the current directory up to the repository root)
and validates it. It exits 1 when the file is invalid.

## Binaries

`pnpm build:cli` compiles standalone binaries with `bun build --compile` into `dist/`:
`selfhost-linux-x64`, `selfhost-linux-arm64`, `selfhost-darwin-arm64` and `selfhost-darwin-x64`.
Pass target names to build a subset, for example `pnpm build:cli bun-darwin-arm64`.
