import { useEffect, useState } from 'react';

import type { FleetSnapshot, SessionStatusEvent } from '#src/lib/admin-api';
import {
  FLEET_POLL_INTERVAL_MS,
  FLEET_STREAM_URL,
  adminApi,
} from '#src/lib/admin-api';
import { ApiError, isApiErrorCode } from '#src/lib/api-error';

/**
 * Health of the `/fleet` **poll**, which is a different question from the SSE
 * connection `connected` reports (PLAN-VisibleErrors §4.4). The poll is what
 * refreshes every number on the fleet panel; the stream only carries
 * per-session connectivity deltas. Before this existed the two were conflated,
 * so a dead poll could sit behind a healthy-looking `reconnecting…` chip while
 * the grid froze at its last good snapshot.
 *
 * `lastSuccessAt` is stamped from the **browser's** clock when a read resolves,
 * deliberately not taken from `FleetSnapshot.generatedAt` (the admin-server's
 * clock): the question this answers is "how long since we last heard from the
 * server", and comparing a server timestamp against a local `Date.now()` would
 * render clock skew as staleness and vice versa.
 */
export type FleetPollState =
  /** No read has resolved yet, successfully or otherwise. */
  | { status: 'loading' }
  | { status: 'ok'; lastSuccessAt: number }
  /**
   * A read failed — `TELEMETRY_DEGRADED` from admin-server, or a network/BFF
   * error. `lastSuccessAt` is retained across the failure precisely because the
   * caller keeps rendering that snapshot; it is what makes the age of what is
   * on screen statable.
   */
  | {
      status: 'degraded';
      /** Envelope error code when there was one, e.g. `TELEMETRY_DEGRADED`. */
      code: string | null;
      message: string;
      lastSuccessAt: number | null;
      consecutiveFailures: number;
    }
  /** Telemetry is not configured at all (`REDIS_URL` unset) — a deployment
   *  fact rather than a transient, so the poll stops rather than retrying it
   *  every 5 s for as long as the tab is open. */
  | { status: 'unavailable'; message: string };

export interface FleetState {
  /** Null until the first successful `/fleet` read. */
  snapshot: FleetSnapshot | null;
  /**
   * Latest live connectivity per session, keyed by `sessionUid`, from
   * `/fleet/stream` deltas. `fleetStream()`'s doc comment is explicit that a
   * client must already have `snapshot` and merge these onto it — the stream
   * never carries a full session record, only this connectivity pair — so
   * this is exposed separately rather than spliced into `snapshot.sessions`.
   */
  sessionEvents: Map<string, SessionStatusEvent>;
  /** True once the SSE connection has been established at least once and
   *  hasn't since dropped. The browser retries a drop on its own.
   *
   *  Says nothing about whether `snapshot` is current — see {@link poll}. */
  connected: boolean;
  /** False when telemetry isn't configured at all (`REDIS_URL` unset) — as
   *  opposed to a transient read failure, which leaves this true.
   *  Derived from {@link poll}; kept as its own field because it is the one
   *  state where there is nothing to render at all. */
  available: boolean;
  /** Health and freshness of the `/fleet` poll. @see {@link FleetPollState} */
  poll: FleetPollState;
  /** Re-fetch `/fleet` on demand, e.g. for a manual "retry" affordance. */
  refresh: () => void;
}

/**
 * Seeds fleet state from `GET /fleet`, then layers `/fleet/stream` deltas on
 * top for sub-second connectivity updates.
 *
 * The stream never re-seeds itself — it has no `snapshot` event, and every
 * frame is a plain default `message` (no `event:` name to switch on; the `t`
 * field in the JSON body is the discriminant). So a (re)connect here
 * re-fetches `/fleet` explicitly on the `EventSource`'s `open` event, which
 * is what makes a dropped connection self-heal instead of quietly serving a
 * stale snapshot forever.
 */
export function useFleet(): FleetState {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [sessionEvents, setSessionEvents] = useState<
    Map<string, SessionStatusEvent>
  >(() => new Map());
  const [connected, setConnected] = useState(false);
  const [poll, setPoll] = useState<FleetPollState>({ status: 'loading' });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const alive = { current: true };

    adminApi
      .fleet()
      .then((s) => {
        if (!alive.current) return;
        setSnapshot(s);
        setPoll({ status: 'ok', lastSuccessAt: Date.now() });
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'TELEMETRY_UNAVAILABLE')) {
          setPoll({
            status: 'unavailable',
            message:
              err instanceof ApiError
                ? err.message
                : 'Live fleet telemetry is not configured.',
          });
          return;
        }
        // TELEMETRY_DEGRADED and network errors: the prior snapshot (if any)
        // is deliberately left in place rather than cleared out from under the
        // caller — mid-incident, the last known fleet is evidence, and blanking
        // it substitutes one lie ("nothing is running") for another. What was
        // missing until PLAN-VisibleErrors §4.4 is the other half of that
        // bargain: the failure is now *stated*, and `lastSuccessAt` is carried
        // through it so the caller can say how old what it is showing is. A
        // retained snapshot without a staleness marker is the "looks live but
        // isn't" failure this hook's poll exists to prevent.
        setPoll((prev) => ({
          status: 'degraded',
          code: err instanceof ApiError ? err.code : null,
          message:
            err instanceof ApiError
              ? err.message
              : 'Could not reach the admin server.',
          lastSuccessAt:
            prev.status === 'ok'
              ? prev.lastSuccessAt
              : prev.status === 'degraded'
                ? prev.lastSuccessAt
                : null,
          consecutiveFailures:
            prev.status === 'degraded' ? prev.consecutiveFailures + 1 : 1,
        }));
      });

    return () => {
      alive.current = false;
    };
  }, [refreshNonce]);

  useEffect(() => {
    const es = new EventSource(FLEET_STREAM_URL, { withCredentials: true });

    es.onopen = () => {
      setConnected(true);
      // The stream carries no initial state; re-fetch on every (re)connect so
      // a reconnect after a drop can't silently miss what happened in between.
      setRefreshNonce((n) => n + 1);
    };

    es.onmessage = (e: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      // `parsed` is unknown, not statically `SessionStatusEvent`, so this
      // check is real forward-compat, not a tautology: it still runs once a
      // `node`/`provider` variant ships and `t` is no longer always 'session'.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { t?: unknown }).t !== 'session'
      ) {
        return;
      }
      const event = parsed as SessionStatusEvent;
      setSessionEvents((prev) => new Map(prev).set(event.sessionUid, event));
    };

    es.onerror = () => {
      // The browser retries on its own; this just reflects connection state.
      setConnected(false);
    };

    return () => {
      es.close();
    };
  }, []);

  // Poll cadence: re-read `/fleet` on a timer in addition to the SSE
  // (re)connect re-fetch. Audio levels move on a 2 s publish throttle with a
  // 10 s TTL, so a frozen dBFS readout (the old behaviour: fetch once, then
  // only on reconnect) is worse than none — it looks live. The timer is
  // gated on `document.hidden` so an operator with the dashboard parked on a
  // second monitor does not poll all night.
  //
  // The effect below depends on this primitive rather than on `poll` itself:
  // it owns the interval, and depending on the whole state object would tear
  // the timer down and rebuild it on every poll result — resetting the cadence
  // each time and, once degraded, on every failure too. Only `unavailable` may
  // stop the timer.
  const pollDisabled = poll.status === 'unavailable';

  useEffect(() => {
    // Nothing to poll for when the backplane is not configured at all.
    // TELEMETRY_UNAVAILABLE is a deployment fact rather than a transient —
    // without this guard the hook would re-request `/fleet` every 5 s forever
    // and swallow the identical error each time, for the whole time a tab is
    // left open. A TELEMETRY_DEGRADED failure deliberately does NOT stop the
    // timer: it is exactly the case that recovers on its own, and an operator
    // watching a degraded panel needs it to un-degrade without a reload.
    if (pollDisabled) return;

    const poll = () => {
      setRefreshNonce((n) => n + 1);
    };

    const id = window.setInterval(() => {
      if (!document.hidden) poll();
    }, FLEET_POLL_INTERVAL_MS);

    // A hidden tab skips its ticks, so on the way back in the operator would
    // otherwise be looking at numbers up to a full interval stale — precisely
    // the "looks live but isn't" failure the poll exists to prevent. Refresh
    // immediately on becoming visible and let the timer carry on from there.
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [pollDisabled]);

  const refresh = () => {
    setRefreshNonce((n) => n + 1);
  };

  return {
    snapshot,
    sessionEvents,
    connected,
    available: poll.status !== 'unavailable',
    poll,
    refresh,
  };
}
