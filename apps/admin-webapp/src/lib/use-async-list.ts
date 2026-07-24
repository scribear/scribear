import type { DependencyList } from 'react';
import { useEffect, useState } from 'react';

/** One page of a cursor-paginated list endpoint. */
export interface AsyncListPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

export interface AsyncListState<T> {
  /** All items loaded so far (first page plus any appended pages). */
  items: T[];
  /** True while the first page (mount / `deps` change / `reload`) is loading. */
  loading: boolean;
  /** True while a subsequent page is being appended via `loadMore`. */
  loadingMore: boolean;
  /** Error from the most recent page load, else null. */
  error: unknown;
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
 * pages on `loadMore` (accumulating). Owns the mounted-guard and the two
 * loading flags; callers derive any branch (misconfiguration, ...) from
 * `error` during render.
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
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const alive = { current: true };
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- first-page loading flag before an async fetch; consolidated here so per-site suppressions aren't needed. See REVIEW-EFFECT-SETState.md.
    setLoading(true);
    fetchPage(undefined)
      .then((page) => {
        if (!alive.current) return;
        setError(null);
        setItems(page.items);
        setNextCursor(page.nextCursor);
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
    // The caller owns `deps`; `reloadNonce` forces a manual first-page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps, @eslint-react/exhaustive-deps
  }, [...deps, reloadNonce]);

  const loadMore = () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    fetchPage(nextCursor)
      .then((page) => {
        setError(null);
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        setError(err);
      })
      .finally(() => {
        setLoadingMore(false);
      });
  };

  const reload = () => {
    setReloadNonce((n) => n + 1);
  };

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    reload,
  };
}
