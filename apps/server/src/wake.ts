import { asSystem } from "@selfhost/ledger";

/**
 * Calls `fn` once, `delayMs` after the first of a burst of calls: calls while it waits join that
 * one, so a steady stream of calls still runs it every `delayMs` at most and never later. The timer
 * never keeps the process alive. fn runs outside the org scope of the request that woke it, as
 * the server's own job.
 */
export function wakeAfter(fn: () => unknown, delayMs: number): { (): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void asSystem(fn);
    }, delayMs);
    timer.unref?.();
  };
  wake.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wake;
}
