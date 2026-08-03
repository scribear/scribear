import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import type { AsyncListPage } from '#src/lib/use-async-list';
import { useAsyncList } from '#src/lib/use-async-list';

function page<T>(
  items: T[],
  nextCursor: string | null = null,
): AsyncListPage<T> {
  return { items, nextCursor };
}

describe('useAsyncList', (it) => {
  it('starts in "loading", not in a premature empty "ok"', () => {
    // Arrange
    const fetchPage = vi.fn(
      () => new Promise<AsyncListPage<string>>(() => undefined),
    );

    // Act
    const { result } = renderHook(() => useAsyncList(fetchPage, []));

    // Assert
    expect(result.current.state).toEqual({ status: 'loading' });
  });

  it('moves to "ok" with an empty list when the deployment really has none', async () => {
    // Arrange
    const fetchPage = vi.fn(() => Promise.resolve(page<string>([])));

    // Act
    const { result } = renderHook(() => useAsyncList(fetchPage, []));

    // Assert
    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ok', items: [] });
    });
  });

  it('moves to "unavailable" on a failure, with no items reachable at all', async () => {
    // Arrange - this is the invariant PLAN-VisibleErrors §10.2 asks for: the
    // failed state has no `items` field, so no caller can render "No X found."
    // over an error even by accident.
    const err = new Error('backend down');
    const fetchPage = vi.fn(() => Promise.reject(err));

    // Act
    const { result } = renderHook(() => useAsyncList(fetchPage, []));

    // Assert
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: 'unavailable',
        error: err,
      });
    });
    expect(result.current.state).not.toHaveProperty('items');
  });

  it('reload() re-runs the first page and can recover from "unavailable"', async () => {
    // Arrange
    const fetchPage = vi
      .fn<(cursor: string | undefined) => Promise<AsyncListPage<string>>>()
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce(page(['a']));
    const { result } = renderHook(() => useAsyncList(fetchPage, []));
    await waitFor(() => {
      expect(result.current.state.status).toBe('unavailable');
    });

    // Act
    act(() => {
      result.current.reload();
    });

    // Assert
    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ok', items: ['a'] });
    });
  });

  it('appends a further page on loadMore()', async () => {
    // Arrange
    const fetchPage = vi
      .fn<(cursor: string | undefined) => Promise<AsyncListPage<string>>>()
      .mockResolvedValueOnce(page(['a'], 'cursor-1'))
      .mockResolvedValueOnce(page(['b']));
    const { result } = renderHook(() => useAsyncList(fetchPage, []));
    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });

    // Act
    act(() => {
      result.current.loadMore();
    });

    // Assert
    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ok', items: ['a', 'b'] });
    });
    expect(result.current.hasMore).toBe(false);
  });

  it('keeps the loaded rows when an append fails, reporting it separately', async () => {
    // Arrange - a failed *append* must not blank pages the operator can already
    // see; that would be the mirror image of the bug being fixed.
    const appendErr = new Error('page 2 failed');
    const fetchPage = vi
      .fn<(cursor: string | undefined) => Promise<AsyncListPage<string>>>()
      .mockResolvedValueOnce(page(['a'], 'cursor-1'))
      .mockRejectedValueOnce(appendErr);
    const { result } = renderHook(() => useAsyncList(fetchPage, []));
    await waitFor(() => {
      expect(result.current.hasMore).toBe(true);
    });

    // Act
    act(() => {
      result.current.loadMore();
    });

    // Assert
    await waitFor(() => {
      expect(result.current.loadMoreError).toBe(appendErr);
    });
    expect(result.current.state).toEqual({ status: 'ok', items: ['a'] });
  });
});
