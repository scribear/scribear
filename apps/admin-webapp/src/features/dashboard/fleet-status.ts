import { useMemo } from 'react';

import type {
  FleetSnapshot,
  SessionAudioSnapshot,
  SessionSnapshot,
  SessionStatusEvent,
} from '#src/lib/admin-api';

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

// ---- Audio status (D1: a second, independent axis, not a refinement of the
// connectivity status above) ----

export type AudioStatus = 'good' | 'warn' | 'crit' | 'unknown';

/**
 * Thresholds for `deriveAudioStatus`. Each number's provenance is noted so the
 * later per-room baseline work (D3 of PLAN-AUDIOVIZ) has one place to replace.
 *
 * The clipping threshold (1 %) and the silence flag come straight from the
 * publisher's `AudioLevelStats`. The RMS bounds match the standalone meter's
 * warn/crit zone defaults (-18 / -6 dBFS) for the low/high ends, and the SNR
 * threshold (10 dB) is the point below which speech intelligibility degrades
 * measurably. These are first-cut constants, not tuned values — see
 * PLAN-MONITORING-DASHBOARD.md §59 on per-room baselines.
 */
export const AUDIO_THRESHOLDS = {
  /** Fraction of clipped samples above which the session is crit. */
  clippingPctCrit: 0.01,
  /** RMS below this is very low — likely a muted or far mic. */
  rmsDbfsLow: -50,
  /** RMS above this is hot — approaching clipping. */
  rmsDbfsHigh: -6,
  /** SNR below this (when VAD measured it) means poor signal-to-noise. */
  snrDbPoor: 10,
} as const;

/**
 * Derives an audio status from a session's latest audio snapshot.
 *
 * `unknown` when no snapshot exists; for a live (`OPEN`) session that is
 * itself a finding — see D2 of PLAN-AUDIOVIZ: "no audio reaching ASR" is
 * failure mode C1 (mic muted / unplugged / wrong input).
 *
 * Rules (all constants from `AUDIO_THRESHOLDS`):
 *
 * | Condition | Status |
 * |---|---|
 * | no snapshot **and** `upstreamState === 'OPEN'` | `crit` — "no audio reaching ASR" (C1) |
 * | no snapshot, session not open | `unknown` |
 * | `silence === true` | `crit` — digital silence on a live session |
 * | `clippingPct > 0.01` | `crit` — clipping |
 * | `rmsDbfs < -50` | `warn` — very low level |
 * | `rmsDbfs > -6` | `warn` — hot |
 * | `vadEnabled && snrDb !== null && snrDb < 10` | `warn` — poor SNR |
 * | otherwise | `good` |
 */
export function deriveAudioStatus(
  audio: SessionAudioSnapshot | undefined,
  session: SessionSnapshot,
): AudioStatus {
  if (audio === undefined) {
    return session.upstreamState === 'OPEN' ? 'crit' : 'unknown';
  }
  return classifyAudioSnapshot(audio);
}

/**
 * Classifies an existing audio snapshot into a status, without the "no
 * snapshot" path that `deriveAudioStatus` handles. Used by the session detail
 * page, which already knows a snapshot exists and has no `SessionSnapshot` to
 * pass (its session comes from session-manager, not fleet telemetry).
 */
export function classifyAudioSnapshot(
  audio: SessionAudioSnapshot,
): AudioStatus {
  if (audio.silence) return 'crit';
  if (audio.clippingPct > AUDIO_THRESHOLDS.clippingPctCrit) return 'crit';
  if (audio.rmsDbfs < AUDIO_THRESHOLDS.rmsDbfsLow) return 'warn';
  if (audio.rmsDbfs > AUDIO_THRESHOLDS.rmsDbfsHigh) return 'warn';

  const vad = audio.vadStats;
  if (
    vad !== null &&
    vad.vadEnabled &&
    vad.snrDb !== null &&
    vad.snrDb < AUDIO_THRESHOLDS.snrDbPoor
  ) {
    return 'warn';
  }

  return 'good';
}

/**
 * Indexes `sessionAudio` by `sessionUid` for O(1) lookup per session card.
 * Returns an empty map when the snapshot is null (telemetry unavailable).
 */
export function audioBySession(
  snapshot: FleetSnapshot | null,
): Map<string, SessionAudioSnapshot> {
  const map = new Map<string, SessionAudioSnapshot>();
  if (snapshot === null) return map;
  for (const audio of snapshot.sessionAudio) {
    map.set(audio.sessionUid, audio);
  }
  return map;
}

export interface FleetFilter {
  status?: FleetStatus[];
  providerKey?: string;
  text?: string;
  /** Audio-status facet — `unknown` covers sessions with no audio snapshot. */
  audioStatus?: AudioStatus[];
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
    if (filter.audioStatus !== undefined) next.audioStatus = filter.audioStatus;
    return next;
  }
  return { ...filter, providerKey };
}

export interface FleetRow {
  session: SessionSnapshot;
  status: FleetStatus;
  event: SessionStatusEvent | undefined;
  audio: SessionAudioSnapshot | undefined;
  audioStatus: AudioStatus;
}

export function useFilteredSessions(
  sessions: SessionSnapshot[],
  sessionEvents: Map<string, SessionStatusEvent>,
  audioBySession: Map<string, SessionAudioSnapshot>,
  filter: FleetFilter,
): FleetRow[] {
  return useMemo(() => {
    const t = filter.text?.trim().toLowerCase();
    const rows: FleetRow[] = sessions.map((session) => {
      const event = sessionEvents.get(session.sessionUid);
      const audio = audioBySession.get(session.sessionUid);
      return {
        session,
        status: deriveSessionStatus(session, event),
        event,
        audio,
        audioStatus: deriveAudioStatus(audio, session),
      };
    });
    return rows
      .filter(
        (r) =>
          (!filter.status?.length || filter.status.includes(r.status)) &&
          (!filter.providerKey ||
            r.session.providerKey === filter.providerKey) &&
          (!filter.audioStatus?.length ||
            filter.audioStatus.includes(r.audioStatus)) &&
          (!t ||
            r.session.sessionUid.toLowerCase().includes(t) ||
            (r.session.roomUid?.toLowerCase().includes(t) ?? false)),
      )
      .sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          (pipelineP95(b.session) ?? 0) - (pipelineP95(a.session) ?? 0),
      );
  }, [
    sessions,
    sessionEvents,
    audioBySession,
    filter.status,
    filter.providerKey,
    filter.audioStatus,
    filter.text,
  ]);
}
