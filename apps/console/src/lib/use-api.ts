import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@/lib/api";

export interface Loaded<T> {
  data?: T;
  error?: ApiRequestError;
  loading: boolean;
  /** Loads again, keeping what is on screen until the answer arrives. */
  reload: () => void;
}

/**
 * Loads `load` now and again whenever `key` changes, aborting the request it replaces. A key of
 * null loads nothing.
 */
export function useApi<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: ApiRequestError; loading: boolean }>({
    loading: key !== null,
  });
  const [round, setRound] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    if (key === null) {
      setState({ loading: false });
      return;
    }
    const abort = new AbortController();
    setState((current) => ({ ...current, loading: true }));
    latest
      .current(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setState({ data, loading: false });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof ApiRequestError ? error : new ApiRequestError(0, String(error)),
        }));
      });
    return () => abort.abort();
  }, [key, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { ...state, reload } satisfies Loaded<T>;
}
