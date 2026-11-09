import type { Ledger } from "@selfhost/ledger";
import { type RuntimeForOptions, runtimeFor } from "@selfhost/runtime";
import type { LedgerEvent } from "@selfhost/schema";
import { sandboxSpans, sandboxSpendIn } from "@selfhost/spend";

/** How far back the daily cap looks for sandboxes still running into today. */
const LOOKBACK_MS = 7 * 86_400_000;

/** A team's sandbox spend in a day from the ledger, leaving out `exclude`. */
export async function ledgerSandboxSpend(
  ledger: Ledger,
  team: string,
  exclude: ReadonlySet<string>,
  day: { from: Date; to: Date },
  now: Date,
): Promise<number> {
  const events: LedgerEvent[] = [];
  const from = new Date(day.from.getTime() - LOOKBACK_MS).toISOString();
  for (const kind of ["sandbox.started", "sandbox.stopped"]) {
    let cursor: string | undefined;
    do {
      const page = await ledger.query({ kind, team, from, limit: 1000, cursor });
      events.push(...page.events);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return sandboxSpendIn(sandboxSpans(events).values(), day.from, day.to, now, exclude);
}

/**
 * The runtime seam for background runs on the server: runtime selection over the adapters with
 * the keys in the server's environment, sandbox lifecycle written to the ledger, and the team's
 * [budget] runtime caps read from it. Pass it to createBackground as `runtime`.
 */
export function serverRuntime(
  ledger: Ledger,
  options: Pick<RuntimeForOptions, "env" | "now" | "open"> & { log?: (line: string) => void },
) {
  const now = options.now ?? (() => new Date());
  return runtimeFor({
    ...options,
    emit: async (event) => {
      // Stored under the run's team, so the team's spend views and caps see it.
      await ledger.append([event], event.team ? { team: event.team } : {});
    },
    spentToday: (team, exclude, day) => ledgerSandboxSpend(ledger, team, exclude, day, now()),
    onRefused: (run, refusal) =>
      options.log?.(
        `background run ${run.id} for team ${run.team}: no runtime (${refusal.rule}). ${refusal.message}`,
      ),
  });
}
