import type { DependencyList } from 'react';
import { useEffect, useState } from 'react';

/** One page of a cursor-paginated list endpoint. */
export interface AsyncListPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

/**
 * The first page's outcome, as a discriminated union (PLAN-VisibleErrors
 * §10.2). `items` exist **only** in `ok`, so "the deployment has no rooms" and
 * "we could not ask" cannot be rendered by the same branch — which is exactly
 * what the previous `{ items: [], error }` shape let five pages do.
 *
 * `unavailable` (rather than `failed`/`error`) matches `useAlerts`'
 * `loading | ok | unavailable`, so the console has one idiom for this.
 */
export type AsyncListLoad<T> =
  | { status: 'loading' }
  | { status: 'ok'; items: T[] }
  | { status: 'unavailable'; error: unknown };

export interface AsyncListState<T> {
  /** First-page state. Callers must branch on `status` to reach `items`. */
  state: AsyncListLoad<T>;
  /** True while a subsequent page is being appended via `loadMore`. */
  loadingMore: boolean;
  /**
   * Error from the most recent failed `loadMore`, else null. Kept separate
   * from `state`: a failed *append* must not blank the pages already loaded,
   * so the list stays `ok` and the caller reports the append failure beside
   * the rows it already has.
   */
  loadMoreError: unknown;
  /** True when another page is available. */
  hasMore: boolean;
  /** Append the next page. No-op when exhausted or already appending. */
  loadMore: () => void;
  /** Reload from the first page, e.g. after a mutation. Bypasses `deps`. */
  reload: () => void;
}

/**
 * Cursor-paginated sibling of {@link useAsyncData}. Loads the first page on
 * mount and whenever `deps` change (replacing the list), and appends further
 * pages on `loadMore` (accumulating).
 *
 * `fetchPage` is called with `undefined` for the first page and with the prior
 * page's `nextCursor` for each subsequent page. It should read the current
 * filters/search from its own closure — the first-page fetch re-runs whenever
 * `deps` change, so pass those filters in `deps`.
 *
 * As with {@link useAsyncData}, the one synchronous `setState`-in-effect that
 * the loading flag needs is suppressed once, here. See REVIEW-EFFECT-SETState.md.
 */
export function useAsyncList<T>(
  fetchPage: (cursor: string | undefined) => Promise<AsyncListPage<T>>,
  deps: DependencyList,
): AsyncListState<T> {
  const [state, setState] = useState<AsyncListLoad<T>>({ status: 'loading' });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const alive = { current: true };
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- first-page loading state before an async fetch; consolidated here so per-site suppressions aren't needed. See REVIEW-EFFECT-SETState.md.
    setState({ status: 'loading' });
    fetchPage(undefined)
      .then((page) => {
        if (!alive.current) return;
        setLoadMoreError(null);
        setState({ status: 'ok', items: page.items });
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        // No `items: []` fallback: the caller cannot reach an empty list from
        // here, so it cannot say "No X found." about a load that failed.
        setState({ status: 'unavailable', error: err });
        setNextCursor(null);
      });
    return () => {
      alive.current = false;
    };
    // The caller owns `deps`; `reloadNonce` forces a manual first-page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [...deps, reloadNonce]);

  const loadMore = () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    fetchPage(nextCursor)
      .then((page) => {
        setLoadMoreError(null);
        setState((prev) =>
          // A first-page reload may have superseded this append; only extend a
          // list that is still `ok`.
          prev.status === 'ok'
            ? { status: 'ok', items: [...prev.items, ...page.items] }
            : prev,
        );
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        setLoadMoreError(err);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const reload = () => {
    setReloadNonce((n) => n + 1);
  };

  return {
    state,
    loadingMore,
    loadMoreError,
    hasMore: nextCursor !== null,
    loadMore,
    reload,
  };
}
