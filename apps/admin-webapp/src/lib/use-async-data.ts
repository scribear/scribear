import type { DependencyList } from 'react';
import { useCallback, useEffect, useState } from 'react';

/**
 * The fetch's outcome as a discriminated union — the single-value sibling of
 * {@link AsyncListLoad} (PLAN-VisibleErrors §10.2), with the same
 * `loading | ok | unavailable` vocabulary `useAlerts` uses. `data` is reachable
 * **only** through `ok`, so a page cannot describe a failed load with the
 * wording it uses for an empty one.
 *
 * Additive: `data` / `loading` / `error` below are unchanged and still
 * supported, because a dozen pages read them and most are outside the scope of
 * the change that introduced this. New branches should prefer `state`.
 */
export type AsyncDataLoad<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'unavailable'; error: unknown };

export interface AsyncDataState<T> {
  /** Discriminated view of the same fetch. Prefer this over the three fields below. */
  state: AsyncDataLoad<T>;
  /**
   * Latest successful result, or null before the first success. Retained
   * across a later failure — check `error`/`state` before describing it as
   * current.
   */
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
  // Boxed rather than stored bare so `T` may itself be null (several callers
  // fetch `Session | null`) without "resolved with null" and "never resolved"
  // becoming the same state.
  const [result, setResult] = useState<{ value: T } | null>(null);
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
      .then((value) => {
        if (alive.current) setResult({ value });
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

  // Derived, not stored, so `state` and the three legacy fields can never
  // disagree. The final `loading` branch is unreachable in practice (the
  // effect settles into exactly one of `result`/`error`); it is what the type
  // needs for the window before the first settle.
  const state: AsyncDataLoad<T> = loading
    ? { status: 'loading' }
    : error !== null
      ? { status: 'unavailable', error }
      : result !== null
        ? { status: 'ok', data: result.value }
        : { status: 'loading' };

  return { state, data: result?.value ?? null, loading, error, reload };
}
