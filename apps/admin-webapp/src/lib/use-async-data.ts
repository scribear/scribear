import type { DependencyList } from 'react';
import { useCallback, useEffect, useState } from 'react';

export interface AsyncDataState<T> {
  /** Latest successful result, or null before the first success. */
  data: T | null;
  /** True while a fetch is in flight (including re-fetches). */
  loading: boolean;
  /** The error thrown by the most recent failed fetch, else null. */
  error: unknown;
  /** Re-run the fetcher, e.g. after a mutation. Bypasses `deps`. */
  reload: () => void;
}

/**
 * Runs `fetcher` on mount and whenever `deps` change, tracking loading / error
 * / data and guarding against state updates from a request that has been
 * superseded (deps changed, `reload()` called, or the component unmounted).
 *
 * Replaces the repeated hand-rolled "loading flag + alive guard + fetch +
 * catch + finally" effect idiom across admin-webapp pages. Callers derive any
 * page-specific branches (not-found, misconfiguration, ...) from `error`
 * during render rather than storing them as separate state.
 *
 * The synchronous `setState`-in-effect that the loading-flag idiom needs lives
 * here, suppressed once, so the `set-state-in-effect` lint rules stay live for
 * the rest of the codebase. See REVIEW-EFFECT-SETState.md.
 */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): AsyncDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Bumping this re-runs the effect without changing the caller's `deps`.
  const [reloadNonce, setReloadNonce] = useState(0);

  const reload = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const alive = { current: true };
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- loading flag before an async fetch; consolidated here so per-site suppressions aren't needed. See REVIEW-EFFECT-SETState.md.
    setLoading(true);
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- see above
    setError(null);
    fetcher()
      .then((result) => {
        if (alive.current) setData(result);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(err);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
    // The caller owns `deps`; `reloadNonce` forces a manual re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [...deps, reloadNonce]);

  return { data, loading, error, reload };
}
