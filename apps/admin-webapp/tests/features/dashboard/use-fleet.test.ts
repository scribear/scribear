import { act } from 'react';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { FleetSnapshot, SessionStatusEvent } from '#src/lib/admin-api';
import {
  FLEET_POLL_INTERVAL_MS,
  FLEET_STREAM_URL,
  adminApi,
} from '#src/lib/admin-api';
import { useFleet } from '#src/features/dashboard/use-fleet';

vi.mock('#src/lib/admin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/admin-api')>();
  return {
    ...actual,
    adminApi: { fleet: vi.fn() },
  };
});

const emptySnapshot: FleetSnapshot = {
  generatedAt: 1,
  nodes: [],
  sessions: [],
  transcriptionHosts: [],
  providers: [],
  sessionAudio: [],
};

/**
 * Minimal stand-in for the browser's `EventSource` — jsdom doesn't implement
 * one. Records the constructor args and lets a test dispatch `onopen` /
 * `onmessage` / `onerror` by hand; `close()` just flips a flag so a test can
 * assert teardown happened.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  withCredentials: boolean;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function latestEventSource(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('No FakeEventSource was constructed.');
  return es;
}

describe('useFleet', (it) => {
  let originalEventSource: typeof globalThis.EventSource | undefined;

  beforeEach(() => {
    FakeEventSource.instances = [];
    originalEventSource = globalThis.EventSource;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.EventSource = FakeEventSource as any;
    vi.mocked(adminApi.fleet).mockResolvedValue(emptySnapshot);
  });

  afterEach(() => {
    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).EventSource;
    }
  });

  it('opens a stream to the right URL on mount', () => {
    // Act
    renderHook(() => useFleet());

    // Assert
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = latestEventSource();
    expect(es.url).toBe(FLEET_STREAM_URL);
    expect(es.withCredentials).toBe(true);
  });

  it("an incoming message updates the hook's returned state", () => {
    // Arrange
    const { result } = renderHook(() => useFleet());
    const es = latestEventSource();
    const event: SessionStatusEvent = {
      t: 'session',
      sessionUid: 'session-1',
      transcriptionServiceConnected: true,
      sourceDeviceConnected: false,
      at: 123,
    };

    // Act
    act(() => {
      es.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    });

    // Assert
    expect(result.current.sessionEvents.get('session-1')).toEqual(event);
  });

  it('reflects connection drops and native browser reconnects via connected', () => {
    // Arrange: the hook has no timer-based retry of its own — the doc comment
    // on `connected` says the browser retries the same EventSource on its
    // own, so a "reconnect" here is simulated by firing `onopen` again on the
    // same instance, the way the real browser would after a drop.
    const { result } = renderHook(() => useFleet());
    const es = latestEventSource();

    act(() => {
      es.onopen?.();
    });
    expect(result.current.connected).toBe(true);
    const fetchesAfterFirstOpen = vi.mocked(adminApi.fleet).mock.calls.length;

    // Act: connection drops
    act(() => {
      es.onerror?.();
    });

    // Assert
    expect(result.current.connected).toBe(false);

    // Act: the (same) EventSource reconnects on its own and re-opens
    act(() => {
      es.onopen?.();
    });

    // Assert: connected flips back, and the reconnect re-fetches /fleet so a
    // dropped connection can't silently miss what happened while it was down
    expect(result.current.connected).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(vi.mocked(adminApi.fleet).mock.calls.length).toBeGreaterThan(
      fetchesAfterFirstOpen,
    );
  });

  it('closes the EventSource on unmount and does not reconnect afterwards', () => {
    // Arrange
    const { unmount } = renderHook(() => useFleet());
    const es = latestEventSource();

    // Act
    unmount();

    // Assert
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Act: even if the (closed) source somehow fired more events, there is no
    // live component left to react to them; nothing new is opened.
    act(() => {
      es.onerror?.();
      es.onopen?.();
    });

    // Assert
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('useFleet poll timer', (it) => {
  let originalEventSource: typeof globalThis.EventSource | undefined;
  let originalHidden: boolean;

  beforeEach(() => {
    FakeEventSource.instances = [];
    originalEventSource = globalThis.EventSource;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.EventSource = FakeEventSource as any;
    vi.useFakeTimers();
    vi.mocked(adminApi.fleet).mockResolvedValue(emptySnapshot);
    originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).EventSource;
    }
    Object.defineProperty(document, 'hidden', {
      value: originalHidden,
      writable: true,
      configurable: true,
    });
  });

  it('re-fetches /fleet on the poll interval', () => {
    // Arrange
    renderHook(() => useFleet());
    // The initial mount fetch + the SSE open re-fetch.
    const fetchesAfterMount = vi.mocked(adminApi.fleet).mock.calls.length;

    // Act: advance past one poll interval
    act(() => {
      vi.advanceTimersByTime(FLEET_POLL_INTERVAL_MS);
    });

    // Assert: the timer fired and re-fetched
    expect(vi.mocked(adminApi.fleet).mock.calls.length).toBeGreaterThan(
      fetchesAfterMount,
    );
  });

  it('does not re-fetch while the document is hidden', () => {
    // Arrange
    renderHook(() => useFleet());
    const fetchesAfterMount = vi.mocked(adminApi.fleet).mock.calls.length;

    // Act: hide the document and advance past a poll interval
    Object.defineProperty(document, 'hidden', {
      value: true,
      writable: true,
      configurable: true,
    });
    act(() => {
      vi.advanceTimersByTime(FLEET_POLL_INTERVAL_MS * 3);
    });

    // Assert: no additional fetches while hidden
    expect(vi.mocked(adminApi.fleet).mock.calls.length).toBe(
      fetchesAfterMount,
    );
  });

  it('clears the timer on unmount', () => {
    // Arrange
    const { unmount } = renderHook(() => useFleet());
    const fetchesAfterMount = vi.mocked(adminApi.fleet).mock.calls.length;

    // Act
    unmount();
    act(() => {
      vi.advanceTimersByTime(FLEET_POLL_INTERVAL_MS * 5);
    });

    // Assert: no additional fetches after unmount
    expect(vi.mocked(adminApi.fleet).mock.calls.length).toBe(
      fetchesAfterMount,
    );
  });
});
