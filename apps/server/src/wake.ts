/**
 * Calls `fn` once, `delayMs` after the first of a burst of calls: calls while it waits join that
 * one, so a steady stream of calls still runs it every `delayMs` at most and never later. The timer
 * never keeps the process alive.
 */
export function wakeAfter(fn: () => unknown, delayMs: number): { (): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void fn();
    }, delayMs);
    timer.unref?.();
  };
  wake.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wake;
}
