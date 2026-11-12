import type { Env, Fetch } from "@selfhost/integrations";
import type { SecretResolver } from "./adapters/common.js";
import { RuntimeGuard, runtimeCaps } from "./caps.js";
import { openRuntime } from "./open.js";
import { pickRuntime, type RuntimeRule } from "./select.js";
import type { RuntimeConfig } from "./settings.js";
import { type Emit, type TrackedSandbox, trackSandbox } from "./track.js";
import { RUNTIME_KINDS, type RuntimeAdapter, type RuntimeKind, type Sandbox } from "./types.js";

/** The fields of a background run runtime selection reads. `@selfhost/schema` BackgroundRun fits. */
export interface RunForRuntime {
  id: string;
  team: string;
  org?: string | null;
  repo?: string | null;
  person?: string | null;
  /** The runtime the run asked for, or the [runtime] default it defaulted to. */
  runtime?: string;
}

/** Why a run gets no runtime: a [runtime] rule, a missing key, or a [budget] runtime cap. */
export interface RuntimeRefusal {
  rule: RuntimeRule | "runtime.key" | "budget.runtime_daily_usd";
  message: string;
}

/** What the runtime seam answers instead of an adapter: the reason, to show as it is. */
export interface RuntimeRefused {
  refusal: RuntimeRefusal;
}

export const isRefused = (value: RuntimeAdapter | RuntimeRefused): value is RuntimeRefused =>
  "refusal" in value;

export interface RuntimeForOptions {
  /** Where keys and env: secrets are read: the server's environment. */
  env: Env;
  secrets?: SecretResolver;
  fetch?: Fetch;
  now?: () => Date;
  /** Where sandbox.started and sandbox.stopped go: the ledger. Without it nothing is tracked. */
  emit?: Emit;
  /**
   * The team's sandbox spend today from the ledger, leaving out `exclude`, for [budget]
   * runtime_daily_usd. Without it the daily cap counts only sandboxes this process started.
   */
  spentToday?: (
    team: string,
    exclude: ReadonlySet<string>,
    day: { from: Date; to: Date },
  ) => Promise<number>;
  /** Told why a run got no runtime, for the log; the seam also answers with the refusal. */
  onRefused?: (run: RunForRuntime, refusal: RuntimeRefusal) => void;
  /** Opens an adapter. Default: openRuntime with the team's key from `env`. Tests pass a fake. */
  open?: (kind: RuntimeKind, config: RuntimeConfig) => RuntimeAdapter;
  /** How often running sandboxes are checked against the caps. Default 60 seconds. */
  capCheckMs?: number;
}

/** The label every sandbox of a run carries, to find what a failed create left behind. */
const RUN_LABEL = "selfhost-run";

const isKind = (value: string | undefined): value is RuntimeKind =>
  value !== undefined && (RUNTIME_KINDS as readonly string[]).includes(value);

/**
 * The runtime seam of background runs: `(run, config) => RuntimeAdapter | RuntimeRefused`, as
 * `createBackground({ runtime })` takes it. It picks the runtime with pickRuntime ([runtime] in
 * the team's selfhost.toml), opens it with the team's own key, and refuses (a RuntimeRefused
 * naming the rule and saying why, also told to onRefused) a runtime the policy does not allow, a
 * missing key, or a team over [budget] runtime_daily_usd. Sandboxes created through it are sized
 * and placed as picked, write sandbox.started and sandbox.stopped with their cost and idle time,
 * and are stopped at the team's runtime caps.
 */
export function runtimeFor(options: RuntimeForOptions) {
  const now = options.now ?? (() => new Date());
  const guards = new Map<string, RuntimeGuard>();
  const open =
    options.open ??
    ((kind: RuntimeKind, config: RuntimeConfig) =>
      openRuntime(kind, config, {
        env: options.env,
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      }));

  // Caps are read from the policy each run passes in, so a cap lowered or removed by a policy
  // push holds from the next run on, and for the sandboxes already running at the next check.
  const guardFor = (team: string, config: RuntimeConfig) => {
    const caps = runtimeCaps(config.budget);
    let guard = guards.get(team);
    if (guard) {
      guard.setCaps(caps);
      return guard;
    }
    if (caps.daily === undefined && caps.run === undefined) return undefined;
    guard = new RuntimeGuard({
      caps,
      spentToday: (exclude, day) => options.spentToday?.(team, exclude, day) ?? Promise.resolve(0),
      emit: options.emit ?? (() => {}),
      now,
    });
    guard.start(options.capCheckMs);
    guards.set(team, guard);
    return guard;
  };

  return async (
    run: RunForRuntime,
    config: RuntimeConfig,
  ): Promise<RuntimeAdapter | RuntimeRefused> => {
    const refuse = (refusal: RuntimeRefusal): RuntimeRefused => {
      options.onRefused?.(run, refusal);
      return { refusal };
    };
    // A run that names no runtime defaults to [runtime] default; under cheapest_allowed that
    // default is not a request, so policy picks.
    const fallback = config.runtime?.default ?? config.integrations?.runtime?.tool;
    const asked =
      isKind(run.runtime) &&
      !(config.runtime?.policy === "cheapest_allowed" && run.runtime === fallback)
        ? run.runtime
        : undefined;
    const choice = pickRuntime(config, asked ? { kind: asked } : {}, { env: options.env });
    if (!choice.ok) return refuse({ rule: choice.rule, message: choice.message });
    let adapter: RuntimeAdapter;
    try {
      adapter = open(choice.kind, config);
    } catch (error) {
      return refuse({
        rule: "runtime.key",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const guard = guardFor(run.team, config);
    try {
      await guard?.admit();
    } catch (error) {
      return refuse({
        rule: "budget.runtime_daily_usd",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const context = {
      run_id: run.id,
      team: run.team,
      ...(run.org ? { org: run.org } : {}),
      ...(run.repo ? { repo: run.repo } : {}),
      ...(run.person ? { owner: run.person } : {}),
    };
    return {
      kind: adapter.kind,
      capabilities: adapter.capabilities,
      get: (id) => adapter.get(id),
      list: (labels) => adapter.list(labels),
      async create(spec) {
        const created = new Set<string>();
        let sandbox: Sandbox;
        try {
          sandbox = await adapter.create({
            ...spec,
            ...(spec.size ? {} : { size: choice.size }),
            ...(spec.region || !choice.region ? {} : { region: choice.region }),
            labels: { ...spec.labels, [RUN_LABEL]: run.id },
            onCreated: async (id) => {
              created.add(id);
              await spec.onCreated?.(id);
            },
          });
        } catch (error) {
          await stopAfterFailedCreate(adapter, run.id, created);
          throw error;
        }
        if (!options.emit && !guard) return sandbox;
        const tracked = await trackSandbox(sandbox, {
          emit: options.emit ?? (() => {}),
          context,
          size: choice.size,
          ...(choice.region ? { region: choice.region } : {}),
          ...(choice.usdPerHour !== undefined ? { usdPerHour: choice.usdPerHour } : {}),
          now,
        });
        guard?.watch(tracked);
        return endsWithRun(tracked, () => guard?.forget(tracked.id));
      },
    };
  };
}

/**
 * Stops what a failed create may have left running: the sandboxes the adapter reported, and
 * where the provider lists by label, any carrying the run's label (a create call that timed out
 * on the client can still finish on the provider). Coder lists every workspace selfhost made, so
 * there only the reported ones are stopped. Best effort: the create's own error is what counts.
 */
async function stopAfterFailedCreate(
  adapter: RuntimeAdapter,
  runId: string,
  created: ReadonlySet<string>,
): Promise<void> {
  const ids = new Set(created);
  if (adapter.capabilities.labels !== false) {
    const listed = await adapter.list({ [RUN_LABEL]: runId }).catch(() => []);
    for (const { id } of listed) ids.add(id);
  }
  for (const id of ids) {
    try {
      await (await adapter.get(id))?.stop();
    } catch {
      // Left for `selfhost runtime reap`, which finds it by the managed label.
    }
  }
}

/** The runner stops a run's sandbox when the run ends: that stop is recorded as run_ended. */
function endsWithRun(tracked: TrackedSandbox, forget: () => void): Sandbox {
  return {
    ...tracked,
    async stop() {
      forget();
      tracked.markRunEnded();
      await tracked.stop();
    },
  };
}
