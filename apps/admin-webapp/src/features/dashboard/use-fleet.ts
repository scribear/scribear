import { useEffect, useState } from 'react';

import type { FleetSnapshot, SessionStatusEvent } from '#src/lib/admin-api';
import {
  FLEET_POLL_INTERVAL_MS,
  FLEET_STREAM_URL,
  adminApi,
} from '#src/lib/admin-api';
import { isApiErrorCode } from '#src/lib/api-error';

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
   *  hasn't since dropped. The browser retries a drop on its own. */
  connected: boolean;
  /** False when telemetry isn't configured at all (`REDIS_URL` unset) — as
   *  opposed to a transient read failure, which leaves this true. */
  available: boolean;
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
  const [available, setAvailable] = useState(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const alive = { current: true };

    adminApi
      .fleet()
      .then((s) => {
        if (alive.current) setSnapshot(s);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        if (isApiErrorCode(err, 'TELEMETRY_UNAVAILABLE')) setAvailable(false);
        // TELEMETRY_DEGRADED and network errors: leave the prior snapshot (if
        // any) in place rather than clearing it out from under the caller.
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
  useEffect(() => {
    // Nothing to poll for when the backplane is not configured at all.
    // `available` only goes false on TELEMETRY_UNAVAILABLE, which is a
    // deployment fact rather than a transient — without this guard the hook
    // would re-request `/fleet` every 5 s forever and swallow the identical
    // error each time, for the whole time a tab is left open.
    if (!available) return;

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
  }, [available]);

  const refresh = () => {
    setRefreshNonce((n) => n + 1);
  };

  return { snapshot, sessionEvents, connected, available, refresh };
}
