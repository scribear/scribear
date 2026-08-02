import { FLEET_POLL_INTERVAL_MS } from '#src/lib/admin-api';

import type { FleetPollState } from './use-fleet';

/**
 * How old the last successful `/fleet` read may get before what is on screen
 * stops being "a moment behind" and becomes "no longer describing the fleet".
 *
 * Three poll intervals, chosen against the publisher rather than by feel: the
 * backplane expires session audio-stats keys after `AUDIO_STATS_TTL_MS`
 * (10 s — `infra/scribear-redis/src/telemetry/telemetry-timing.ts`), so once a
 * snapshot is 15 s old *every* audio reading drawn from it has certainly
 * outlived its own TTL server-side. Before that point the numbers are merely
 * late; after it they are expired, and the difference is worth an escalation.
 */
export const FLEET_STALE_AFTER_MS = 3 * FLEET_POLL_INTERVAL_MS;

/**
 * Severity of the freshness state, in the PLAN §10 vocabulary: `ok` maps to
 * "waiting/expected, no action"; `warning` to "degraded, retrying, no action
 * yet"; `error` to "what is on screen is not the fleet, stop reading it as
 * such".
 */
export type FreshnessSeverity = 'ok' | 'warning' | 'error';

export interface TelemetryFreshness {
  severity: FreshnessSeverity;
  /** Age of the newest successful read, or null when there has never been one. */
  ageMs: number | null;
  /**
   * Epoch ms of the newest successful read, or null when there has never been
   * one. An absolute clock time derived from this is what belongs in the
   * assertive banner — unlike {@link ageMs} it changes only when a read
   * actually lands, so it does not re-announce itself once per second.
   */
  lastSuccessAt: number | null;
  /** True while the panel is showing a snapshot it knows is not current. */
  stale: boolean;
  /**
   * Cause + audience, as one **stable** sentence. Deliberately carries no
   * relative age: this string lands in an assertive `role="alert"` region, and
   * a ticking "2m 14s" inside one would re-announce itself to a screen-reader
   * user every second. The ticking readout lives in the chip, outside any live
   * region; the absolute clock time comes from {@link lastSuccessAt}, which
   * changes only when a read actually succeeds.
   */
  headline: string | null;
  /** Verbatim cause from the failed read, when there was one. */
  cause: string | null;
  /** What the operator should do. Never null when `headline` is non-null. */
  nextAction: string | null;
}

/**
 * Human age, coarse on purpose: an operator reads this to decide whether to
 * trust the grid, not to time anything. Sub-minute resolves to seconds, past
 * an hour it stops counting seconds entirely.
 */
export function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

const RETRY_NOTE = `The console keeps retrying every ${String(
  Math.round(FLEET_POLL_INTERVAL_MS / 1000),
)} seconds.`;

const CHECK_NOTE =
  'If it does not clear on its own, check that admin-server can reach the Redis telemetry backplane (REDIS_URL) and that the node-server and transcription-service publishers are running.';

/**
 * Classifies how much of the fleet panel can still be believed.
 *
 * Severity is driven by the **age of the data**, not only by whether the last
 * request threw. That matters for two states a status-only rule gets wrong: a
 * request that hangs rather than rejecting never produces a failure yet leaves
 * the panel just as frozen, and a tab that has been hidden for an hour returns
 * with `status: 'ok'` and an hour-old snapshot on screen. Both are stale, and
 * an operator glancing at the grid cannot tell either from live.
 *
 * @param poll Poll state from `useFleet`.
 * @param now Current epoch ms — injected so this is testable without fake timers.
 */
export function deriveFreshness(
  poll: FleetPollState,
  now: number,
): TelemetryFreshness {
  if (poll.status === 'unavailable') {
    return {
      severity: 'error',
      ageMs: null,
      lastSuccessAt: null,
      stale: false,
      headline: null,
      cause: poll.message,
      nextAction: null,
    };
  }

  if (poll.status === 'loading') {
    return {
      severity: 'ok',
      ageMs: null,
      lastSuccessAt: null,
      stale: false,
      headline: null,
      cause: null,
      nextAction: null,
    };
  }

  // Both remaining variants carry it; `ok` narrows it to a number.
  const lastSuccessAt: number | null = poll.lastSuccessAt;
  const ageMs =
    lastSuccessAt === null ? null : Math.max(0, now - lastSuccessAt);

  if (poll.status === 'degraded' && ageMs === null) {
    // Never had a good read and the current one failed. There is nothing on
    // screen to mark as stale — the honest statement is that the view is empty
    // because the read failed, not because the fleet is idle (PLAN §5's bug,
    // in the one place it would be least noticed).
    return {
      severity: 'error',
      ageMs: null,
      lastSuccessAt: null,
      stale: false,
      headline:
        'Live fleet telemetry could not be read, so this view has never had any data. An empty fleet panel here does not mean the fleet is idle.',
      cause: poll.message,
      nextAction: `${RETRY_NOTE} ${CHECK_NOTE}`,
    };
  }

  const age = ageMs ?? 0;
  const beyondThreshold = age >= FLEET_STALE_AFTER_MS;

  if (poll.status === 'degraded') {
    return {
      severity: beyondThreshold ? 'error' : 'warning',
      ageMs: age,
      lastSuccessAt,
      stale: true,
      headline: beyondThreshold
        ? 'Live fleet telemetry has stopped updating. Every session, audio level and capacity figure below is frozen at the time shown and no longer describes the fleet — do not read this grid as current.'
        : 'Live fleet telemetry missed its last update. What is below is the most recent snapshot that arrived, not the current state of the fleet.',
      cause: poll.message,
      nextAction: beyondThreshold
        ? `${RETRY_NOTE} ${CHECK_NOTE} Until it clears, treat the alerts panel and the per-room pages as the current picture rather than this grid.`
        : RETRY_NOTE,
    };
  }

  // status === 'ok', but the newest read may still be old: a hidden tab pauses
  // the poll, and a hung request never rejects.
  if (beyondThreshold) {
    return {
      severity: 'warning',
      ageMs: age,
      lastSuccessAt,
      stale: true,
      headline:
        'The newest fleet snapshot is older than one poll cycle, so the grid below may lag the fleet. No read has failed — the poll pauses while this tab is hidden and a request can hang without erroring.',
      cause: null,
      nextAction: 'It refreshes as soon as the next read lands.',
    };
  }

  return {
    severity: 'ok',
    ageMs: age,
    lastSuccessAt,
    stale: false,
    headline: null,
    cause: null,
    nextAction: null,
  };
}

/**
 * Text for the age chip beside the panel heading. Always carries a word as
 * well as an age, so the chip's colour is never the only thing distinguishing
 * "fresh" from "frozen" (SC 1.4.1) — the same rule `CapacityMeterBar`'s
 * "N / N*" readout follows.
 */
export function freshnessChipLabel(freshness: TelemetryFreshness): string {
  const { ageMs, stale } = freshness;
  if (ageMs === null) return stale ? 'no data' : 'waiting for first update';
  return stale
    ? `not updating · ${formatAge(ageMs)} old`
    : `updated ${formatAge(ageMs)} ago`;
}
