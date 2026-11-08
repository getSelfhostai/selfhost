import { isPostgresUrl, openLedger } from "@selfhost/ledger";
import {
  DEFAULT_LAG_MS,
  type ExportResult,
  exportSettings,
  exportTraces,
  otlpSender,
  type RunExportSettings,
  type TraceSpan,
  tracesUrl,
} from "@selfhost/traces";
import type { Command } from "commander";
import { describeTarget } from "./import.js";
import { loadConfig } from "./review.js";

export interface TracesExportOptions {
  since?: string;
  dryRun?: boolean;
  config?: string;
  database?: string;
  dataDir?: string;
  json?: boolean;
}

interface TracesIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  write: (line: string) => void;
  setExitCode: (code: number) => void;
  now?: Date;
}

/** `selfhost traces export --json`. */
export interface TracesExportReport {
  schema: "selfhost.traces_export/v1";
  dry_run: boolean;
  /** `[integrations.tracer]`, without its header variables. null when none is set (dry run). */
  tracer: { tool: string; endpoint: string } | null;
  /** Runs sent, or that would be. A dry run lists every span. */
  sent: { run: string; spans: number | TraceSpan[] }[];
  pending: string[];
  failed: { run: string; error: string }[];
  ledger: string;
}

function parseSince(value: string): string {
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(time)) {
    throw new Error(
      `--since: expected a date like 2026-10-01 or a time with a UTC offset, got "${value}"`,
    );
  }
  return new Date(time).toISOString();
}

/**
 * Sends the local ledger's finished runs to `[integrations.tracer]` in selfhost.toml: each agent
 * session as one OpenTelemetry trace, the same spans the team server sends. Runs already sent
 * are not sent again; runs still going wait for the next export. Prompt text goes only with
 * `[ledger] log_prompts` on.
 */
export async function runTracesExport(
  options: TracesExportOptions,
  io: TracesIo,
): Promise<TracesExportReport> {
  const { config } = loadConfig(io.cwd, options.config, io);
  const found = exportSettings(config);
  if (!found && !options.dryRun) {
    throw new Error(
      "No [integrations.tracer] in selfhost.toml. Add one with tool and endpoint (and headers_env for the API key), or pass --dry-run to see what would be sent.",
    );
  }
  const settings: RunExportSettings = found ?? {
    tracer: { tool: "otlp", endpoint: "http://localhost:4318" },
    logPrompts: config.ledger.log_prompts,
    patterns: config.redaction,
  };
  const url = options.database ?? io.env.DATABASE_URL;
  const postgres = url !== undefined && isPostgresUrl(url);
  const ledger = await openLedger(postgres ? { url } : { dataDir: options.dataDir });
  let result: ExportResult;
  try {
    result = await exportTraces(ledger, {
      // A laptop ledger is solo: its own selfhost.toml covers every run.
      settingsFor: async () => settings,
      sender: (tracer) => otlpSender(tracer, { env: io.env }),
      ...(io.now ? { now: io.now } : {}),
      // The embedded ledger has one writer at a time; a shared Postgres may have more.
      lagMs: postgres ? DEFAULT_LAG_MS : 0,
      ...(options.since ? { since: parseSince(options.since) } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
      runsPerPass: 10_000,
    });
  } finally {
    await ledger.close();
  }
  const report: TracesExportReport = {
    schema: "selfhost.traces_export/v1",
    dry_run: options.dryRun === true,
    tracer: found ? { tool: found.tracer.tool, endpoint: found.tracer.endpoint } : null,
    sent: result.sent.map((r) => ({
      run: r.run,
      spans: options.dryRun ? r.spans : r.spans.length,
    })),
    pending: result.pending,
    failed: result.failed,
    ledger: describeTarget(options, io),
  };
  if (result.failed.length > 0) io.setExitCode(1);
  if (options.json) {
    io.write(JSON.stringify(report, null, 2));
    return report;
  }
  const spans = result.sent.reduce((sum, r) => sum + r.spans.length, 0);
  const where = found ? `${found.tracer.tool} (${tracesUrl(found.tracer.endpoint)})` : "a tracer";
  if (options.dryRun) {
    io.write(
      `Would send ${spans} spans from ${result.sent.length} runs to ${where}. Nothing was sent.`,
    );
    for (const r of result.sent) io.write(`  ${r.run}: ${r.spans.length} spans`);
  } else {
    io.write(`Sent ${spans} spans from ${result.sent.length} runs to ${where}.`);
  }
  if (result.pending.length > 0) {
    io.write(`${result.pending.length} runs are still going; they go out once they end.`);
  }
  for (const failed of result.failed) io.write(`Could not send run ${failed.run}: ${failed.error}`);
  io.write(`Ledger: ${report.ledger}`);
  return report;
}

export function registerTraces(
  program: Command,
  io: () => TracesIo,
  fail: (error: unknown, json: boolean | undefined) => void,
): void {
  const traces = program
    .command("traces")
    .description(
      "send agent runs to the team's tracer (Langfuse, Phoenix, Datadog or any OTLP endpoint)",
    );
  traces
    .command("export")
    .description(
      "send finished runs in the local ledger to [integrations.tracer], each as one OpenTelemetry trace",
    )
    .option(
      "--since <date>",
      "only runs with events from this date on (sent runs are still skipped)",
    )
    .option("--dry-run", "build the spans and print them; send and record nothing")
    .option("-c, --config <path>", "path to selfhost.toml")
    .option("--database <url>", "Postgres url (default: DATABASE_URL, else the embedded ledger)")
    .option("--data-dir <path>", "embedded ledger folder (default: ~/.selfhost/data)")
    .option("--json", "print JSON")
    .action(async (options: TracesExportOptions) => {
      try {
        await runTracesExport(options, io());
      } catch (error) {
        fail(error, options.json);
      }
    });
}
