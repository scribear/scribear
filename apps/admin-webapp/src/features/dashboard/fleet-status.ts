import { useMemo } from 'react';

import type { SessionSnapshot, SessionStatusEvent } from '#src/lib/admin-api';

/**
 * `SessionSnapshot.roomUid` is opaque telemetry, not a link to room-management
 * data (`PLAN-fleet-and-testaudio.md` §B.4's `RoomTelemetry` grouping predates
 * the real B1.7 schema and doesn't exist on the wire). The grid below is
 * therefore still session-centric: one card per `sessionUid`, not per room -
 * `roomUid` is surfaced and searchable on the card, not used to group it.
 */
export type FleetStatus = 'good' | 'warn' | 'crit' | 'idle';

const RANK: Record<FleetStatus, number> = {
  crit: 0,
  warn: 1,
  good: 2,
  idle: 3,
};

/**
 * No writer publishes a canonical per-session status today, so this derives
 * one from the upstream connection state, refined by the live `/fleet/stream`
 * connectivity event when one has arrived for this session (it is more
 * current than the state baked into the last `/fleet` snapshot).
 */
export function deriveSessionStatus(
  session: SessionSnapshot,
  event: SessionStatusEvent | undefined,
): FleetStatus {
  if (
    event &&
    (!event.sourceDeviceConnected || !event.transcriptionServiceConnected)
  ) {
    return 'crit';
  }
  switch (session.upstreamState) {
    case 'OPEN':
      return 'good';
    case 'WAITING_RETRY':
    case 'CONNECTING':
    case 'HANDSHAKING':
      return 'warn';
    case 'CLOSED':
      return 'crit';
    case 'IDLE':
    default:
      return 'idle';
  }
}

/** `p95` of the final pipeline-latency series, or `null` if none has landed yet. */
export function pipelineP95(session: SessionSnapshot): number | null {
  const series = session.latency.find(
    (l) => l.measure === 'pipeline' && l.kind === 'final',
  );
  return series && series.count > 0 ? series.p95 : null;
}

export interface FleetFilter {
  status?: FleetStatus[];
  providerKey?: string;
  text?: string;
}

/**
 * `exactOptionalPropertyTypes` forbids assigning `providerKey: undefined`
 * directly in an object literal, so clearing the filter needs an explicit
 * key-drop rather than a spread with an undefined value.
 */
export function setProviderKey(
  filter: FleetFilter,
  providerKey: string | undefined,
): FleetFilter {
  if (providerKey === undefined) {
    const next: FleetFilter = {};
    if (filter.status !== undefined) next.status = filter.status;
    if (filter.text !== undefined) next.text = filter.text;
    return next;
  }
  return { ...filter, providerKey };
}

export interface FleetRow {
  session: SessionSnapshot;
  status: FleetStatus;
  event: SessionStatusEvent | undefined;
}

export function useFilteredSessions(
  sessions: SessionSnapshot[],
  sessionEvents: Map<string, SessionStatusEvent>,
  filter: FleetFilter,
): FleetRow[] {
  return useMemo(() => {
    const t = filter.text?.trim().toLowerCase();
    const rows: FleetRow[] = sessions.map((session) => {
      const event = sessionEvents.get(session.sessionUid);
      return { session, status: deriveSessionStatus(session, event), event };
    });
    return rows
      .filter(
        (r) =>
          (!filter.status?.length || filter.status.includes(r.status)) &&
          (!filter.providerKey ||
            r.session.providerKey === filter.providerKey) &&
          (!t ||
            r.session.sessionUid.toLowerCase().includes(t) ||
            (r.session.roomUid?.toLowerCase().includes(t) ?? false)),
      )
      .sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          (pipelineP95(b.session) ?? 0) - (pipelineP95(a.session) ?? 0),
      );
  }, [sessions, sessionEvents, filter.status, filter.providerKey, filter.text]);
}
