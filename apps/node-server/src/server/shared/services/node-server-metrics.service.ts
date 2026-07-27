import { randomUUID } from 'node:crypto';

import {
  type LatencySummary,
  LatencyWindow,
} from '#src/server/shared/services/latency-window.js';

/** Which side initiated a WebSocket close. */
export type CloseInitiator = 'server' | 'peer';

/** Connection role, mirroring `TranscriptionStreamRole`. */
export type ConnectionRole = 'source' | 'client';

/**
 * Upstream connection state, mirroring `ConnectionState` from
 * `@scribear/base-websocket-client`. Restated rather than imported to keep
 * this service dependency-free; the two are structurally identical, so a real
 * `ConnectionState` is accepted wherever this appears.
 */
export type UpstreamState =
  | 'IDLE'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'OPEN'
  | 'WAITING_RETRY'
  | 'CLOSED';

/** How a latency sample's end-to-end time turned out. */
export type E2eOutcome = 'ok' | 'unavailable' | 'negative';

/**
 * Which transcript a latency sample describes, mirroring `LatencyKind` from
 * `@scribear/node-server-schema`. Restated for the same reason as
 * {@link UpstreamState}: this service stays dependency-free, and the two are
 * structurally identical, so a real `LatencyKind` is accepted here.
 */
export type LatencySampleKind = 'final' | 'inProgress';

/** Which leg of the journey a latency window measures. */
export type LatencyMeasure = 'pipeline' | 'e2e';

/** One latency observation, as correlated by the orchestrator. */
export interface LatencySample {
  sessionUid: string;
  kind: LatencySampleKind;
  /** Audio ingress -> transcript received, on the monotonic clock. */
  pipelineMs: number;
  /**
   * Source capture -> transcript received, on the (clock-corrected) source
   * clock. Null when no timestamp was supplied or the result was negative.
   */
  e2eMs: number | null;
  e2eOutcome: E2eOutcome;
}

/** A latency summary tagged with the series it describes. */
export interface LatencySeries extends LatencySummary {
  measure: LatencyMeasure;
  kind: LatencySampleKind;
}

/**
 * Separator joining label parts into one map key. ASCII unit separator: it
 * cannot occur in any label value (close reasons are normalised against an
 * allowlist, roles and states are closed sets), so a key can always be split
 * back apart unambiguously. Deliberately not NUL, which would make git treat
 * this file as binary and show no diff on review.
 */
const LABEL_SEPARATOR = '\u001f';

/** A labelled counter's key parts, joined into one map key. */
function labelKey(...parts: (string | number)[]): string {
  return parts.join(LABEL_SEPARATOR);
}

/**
 * Every close reason node-server itself emits. Peers supply their own reason
 * string on a peer-initiated close, and that text is arbitrary, remote-supplied
 * and unbounded - recording it verbatim would let any client grow the label map
 * without limit. Unrecognised reasons collapse to `other`.
 *
 * This is an allowlist of what stays *legible*, not an inventory of what is
 * currently reachable, and the two entries below are deliberately kept despite
 * being unreachable as shipped. Removing an entry is not a no-op: the reason
 * would then be normalised to `other` if it ever occurred, so the one close
 * that most needs naming would arrive anonymous, in the same bucket as remote
 * junk text. An entry costs one string in a `Set` and creates no label
 * combination until something actually closes with it.
 *
 * - `binary-before-auth`: no longer closes anything. Pre-auth binary is dropped
 *   and counted (`recordBinaryBeforeAuthDrop`) precisely to stop the 1008
 *   reconnect loop it used to cause. Kept because a peer, or a reintroduced
 *   close path, would otherwise report as `other`.
 * - `no-more-sources`: emitted only on the *upstream* terminate
 *   (`transcription-orchestrator.service.ts`), and `recordWsClose` is called
 *   only for downstream client/source sockets, so it cannot be recorded today.
 *   Kept for when upstream closes are counted too - and because a downstream
 *   peer echoing that text is worth seeing under its own name.
 */
const KNOWN_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'auth-timeout',
  'invalid-token',
  'token-expired',
  'session-mismatch',
  'missing-scope',
  'orchestrator-unavailable',
  'binary-not-allowed-for-role',
  // Unreachable as shipped; retained on purpose - see the doc comment above.
  'binary-before-auth',
  'invalid-json',
  'invalid-message',
  'session-ended',
  // Unreachable as shipped; retained on purpose - see the doc comment above.
  'no-more-sources',
  '',
]);

/**
 * Retained samples per series, process-wide. 4096 matches the sidecar's and
 * transcription-service's histogram depth.
 */
const PROCESS_LATENCY_CAPACITY = 4096;

/**
 * Retained samples per series, per session. Deliberately far smaller than the
 * process-wide depth: it is multiplied by four series and by every live
 * session, and a room's percentiles are wanted "right now" rather than over
 * its whole history.
 */
const SESSION_LATENCY_CAPACITY = 512;

/**
 * The four latency windows kept for one scope: {pipeline, e2e} x
 * {final, inProgress}.
 *
 * Split by kind because the two are not the same population - an interim
 * transcript is emitted while the provider is still listening, a final one
 * only once it decides an utterance ended, so finals are routinely several
 * times slower. Pooled, the p50 would describe interims and the p95 would
 * describe finals, and neither number would mean anything. The split costs 2x
 * memory and two extra series.
 */
class LatencyAggregate {
  private readonly _capacity: number;
  private _windows = new Map<string, LatencyWindow>();

  constructor(capacity: number) {
    this._capacity = capacity;
  }

  observe(
    measure: LatencyMeasure,
    kind: LatencySampleKind,
    valueMs: number,
  ): void {
    const key = labelKey(measure, kind);
    let window = this._windows.get(key);
    if (window === undefined) {
      window = new LatencyWindow(this._capacity);
      this._windows.set(key, window);
    }
    window.observe(valueMs);
  }

  /**
   * Every series with at least one retained sample. A series that has never
   * been observed is omitted rather than reported as zeroes, matching how the
   * labelled counters treat absent label combinations.
   */
  series(): LatencySeries[] {
    const out: LatencySeries[] = [];
    for (const [key, window] of this._windows) {
      const summary = window.summary();
      if (summary === null) continue;
      const [measure = '', kind = ''] = key.split(LABEL_SEPARATOR);
      out.push({
        measure: measure as LatencyMeasure,
        kind: kind as LatencySampleKind,
        ...summary,
      });
    }
    return out;
  }
}

/** Live, per-session numbers. Deleted when the session's last connection goes. */
interface SessionCounts {
  subscriberCount: number;
  /**
   * Created on the session's first latency sample; many sessions never produce
   * one, and four empty windows each would be pure overhead.
   */
  latency: LatencyAggregate | null;
}

/**
 * Process-wide telemetry counters for node-server (monitoring plan B1.1).
 *
 * A singleton, because the signals it collects originate in objects with
 * different lifetimes: WebSocket close codes and auth outcomes happen in
 * `TranscriptionStreamController`, which is request-scoped and dies with the
 * connection, while session and upstream state live on the orchestrator
 * singleton. Neither could hold the full picture alone.
 *
 * Counters are monotonic for the life of the process and are never reset;
 * consumers difference successive reads to get rates. {@link processUid}
 * changes on every boot so a consumer can tell a restart (counters back to
 * zero) from a genuine decrease, which would otherwise read as a large
 * negative rate.
 *
 * Deliberately dependency-free: no logger, no clock injection, no Prometheus
 * client. Call sites keep their own logging, and translation to Prometheus is
 * the monitoring sidecar's job.
 */
export class NodeServerMetricsService {
  /** Identifies this process instance; regenerated on every boot. */
  readonly processUid = randomUUID();
  /** Process start, as an ISO timestamp. */
  readonly processStartedAt = new Date().toISOString();

  private _sessions = new Map<string, SessionCounts>();
  private _latency = new LatencyAggregate(PROCESS_LATENCY_CAPACITY);

  private _decodeDropsTotal = 0;
  private _binaryBeforeAuthDropsTotal = 0;
  private _pendingChunkEvictionsTotal = 0;
  private _upstreamChurnTotal = 0;
  private _authSuccessTotal = 0;
  private _authTimeoutsTotal = 0;
  private _orchestratorFailuresTotal = 0;
  private _latencySamplesTotal = 0;
  private _latencyE2eUnavailableTotal = 0;
  private _latencyE2eNegativeTotal = 0;
  private _latencyUnmatchedChunkTotal = 0;

  private _upstreamStateTransitions = new Map<string, number>();
  private _wsCloses = new Map<string, number>();
  private _authFailures = new Map<string, number>();

  /**
   * A connection subscribed to a session's channels. Counts both roles: a
   * large room's cost is dominated by receive-only clients, and they are
   * invisible to the orchestrator, which only ever sees sources.
   */
  recordConnectionOpen(sessionUid: string): void {
    const counts = this._sessions.get(sessionUid);
    if (counts === undefined) {
      this._sessions.set(sessionUid, { subscriberCount: 1, latency: null });
      return;
    }
    counts.subscriberCount += 1;
  }

  /**
   * A connection unsubscribed. The session's entry is dropped once the last
   * connection goes, so this map tracks live sessions rather than growing for
   * the life of the process.
   */
  recordConnectionClose(sessionUid: string): void {
    const counts = this._sessions.get(sessionUid);
    if (counts === undefined) return;
    counts.subscriberCount -= 1;
    if (counts.subscriberCount <= 0) this._sessions.delete(sessionUid);
  }

  /** Subscribed connections for a session, both roles. */
  subscriberCount(sessionUid: string): number {
    return this._sessions.get(sessionUid)?.subscriberCount ?? 0;
  }

  /** A malformed SAFP frame was dropped instead of forwarded upstream (U2). */
  recordDecodeDrop(): void {
    this._decodeDropsTotal += 1;
  }

  /**
   * A binary frame arrived before the connection authenticated (H1). Dropped
   * rather than closed: a source that begins streaming before AUTH_OK would
   * otherwise be closed 1008 `binary-before-auth` and reconnect-loop, because
   * the auto-reconnect re-sends AUTH and the next first chunk again beats
   * AUTH_OK. Dropping is strictly the better failure mode — the frame is
   * worthless before auth (the orchestrator isn't subscribed yet) and the
   * socket lives to complete auth, after which audio flows normally.
   */
  recordBinaryBeforeAuthDrop(): void {
    this._binaryBeforeAuthDropsTotal += 1;
  }

  /**
   * An un-correlated audio frame was evicted at the per-session pending-chunk
   * cap (N3). Sustained eviction means latency correlation is degraded:
   * transcripts arriving later than the cap can no longer be matched.
   */
  recordPendingChunkEviction(): void {
    this._pendingChunkEvictionsTotal += 1;
  }

  /**
   * An upstream (node -> transcription-service) connection changed state.
   * A transition into `WAITING_RETRY` also counts as churn, which is the
   * BUG.txt / N1 signature.
   */
  recordUpstreamStateChange(from: UpstreamState, to: UpstreamState): void {
    const key = labelKey(from, to);
    this._upstreamStateTransitions.set(
      key,
      (this._upstreamStateTransitions.get(key) ?? 0) + 1,
    );
    if (to === 'WAITING_RETRY') this._upstreamChurnTotal += 1;
  }

  /**
   * A transcription-stream socket closed. `initiator` separates a close we
   * decided on from one the peer performed, so a flapping client uplink does
   * not read as an auth failure.
   *
   * `reason` is normalised against {@link KNOWN_CLOSE_REASONS} because on a
   * peer-initiated close it is remote-supplied text.
   */
  recordWsClose(
    code: number,
    reason: string,
    role: ConnectionRole,
    initiator: CloseInitiator,
  ): void {
    const safeReason = KNOWN_CLOSE_REASONS.has(reason) ? reason : 'other';
    const key = labelKey(code, safeReason, role, initiator);
    this._wsCloses.set(key, (this._wsCloses.get(key) ?? 0) + 1);
  }

  /**
   * An auth attempt was rejected (U3, S2). `reason` is the close reason from
   * `verifyAuth`, e.g. `invalid-token` or `session-mismatch`.
   */
  recordAuthFailure(reason: string): void {
    this._authFailures.set(reason, (this._authFailures.get(reason) ?? 0) + 1);
  }

  /**
   * An auth attempt succeeded. Recorded because the S2 signal (signing-key
   * mismatch between session-manager and node-server) is a *ratio* going to
   * ~1.0, not a count: a handful of failures is normal, all of them failing is
   * config drift. Without this denominator the two are indistinguishable.
   */
  recordAuthSuccess(): void {
    this._authSuccessTotal += 1;
  }

  /** A connection never sent `auth` inside the watchdog window (U3). */
  recordAuthTimeout(): void {
    this._authTimeoutsTotal += 1;
  }

  /** Registering a source with the orchestrator threw; the socket got 1011. */
  recordOrchestratorFailure(): void {
    this._orchestratorFailuresTotal += 1;
  }

  /**
   * A latency sample was published (B1.4).
   *
   * `e2eOutcome` records what happened to the end-to-end figure: `unavailable`
   * when the source sent no timestamp, and `negative` when the computed time
   * was below zero, which means the source clock is still ahead of ours despite
   * sync (S5). Like S2, S5 is a ratio - hence the total alongside.
   *
   * The measured values are also retained in bounded windows, process-wide and
   * per session, so `GET /status` can report percentiles. Before B1.4 a sample
   * was fanned out to subscribed clients and then discarded, which meant the
   * only way to see a room's latency was to be watching that room.
   *
   * `e2eMs` is observed only when it is a real figure; an unavailable or
   * negative sample contributes to the counters above but must not enter the
   * window, where a null coerced to 0 would drag every percentile down and make
   * a clock-skewed source look like the fastest room in the fleet.
   */
  recordLatencySample(sample: LatencySample): void {
    this._latencySamplesTotal += 1;
    if (sample.e2eOutcome === 'unavailable') {
      this._latencyE2eUnavailableTotal += 1;
    } else if (sample.e2eOutcome === 'negative') {
      this._latencyE2eNegativeTotal += 1;
    }

    this._latency.observe('pipeline', sample.kind, sample.pipelineMs);
    if (sample.e2eMs !== null) {
      this._latency.observe('e2e', sample.kind, sample.e2eMs);
    }

    // Attributed to a session only while that session has a live connection.
    // A sample arriving for an unknown session still counts process-wide, but
    // creating an entry for it here would grow the map by every session the
    // process has ever served rather than by the ones it is serving now - the
    // same reasoning that has `recordConnectionClose` delete the entry.
    const counts = this._sessions.get(sample.sessionUid);
    if (counts === undefined) return;
    counts.latency ??= new LatencyAggregate(SESSION_LATENCY_CAPACITY);
    counts.latency.observe('pipeline', sample.kind, sample.pipelineMs);
    if (sample.e2eMs !== null) {
      counts.latency.observe('e2e', sample.kind, sample.e2eMs);
    }
  }

  /**
   * Latency series for one session, empty when it has produced no samples.
   *
   * Per-session windows are discarded with the session's last connection, so
   * these describe live rooms only - the same lifetime as
   * {@link subscriberCount}, and the reason the status endpoint reports them
   * beside it rather than in the process-wide block.
   */
  sessionLatency(sessionUid: string): LatencySeries[] {
    return this._sessions.get(sessionUid)?.latency?.series() ?? [];
  }

  /**
   * A transcript referenced a chunk no longer in the pending map - it was
   * evicted at the cap, or already pruned by an earlier final (N3).
   */
  recordLatencyUnmatchedChunk(): void {
    this._latencyUnmatchedChunkTotal += 1;
  }

  /**
   * Immutable view of every counter. Label maps are returned as arrays of
   * `{ ...labels, count }` so the shape survives JSON serialization, which a
   * `Map` would not.
   */
  snapshot() {
    return {
      processUid: this.processUid,
      processStartedAt: this.processStartedAt,
      decodeDropsTotal: this._decodeDropsTotal,
      binaryBeforeAuthDropsTotal: this._binaryBeforeAuthDropsTotal,
      pendingChunkEvictionsTotal: this._pendingChunkEvictionsTotal,
      upstreamChurnTotal: this._upstreamChurnTotal,
      authSuccessTotal: this._authSuccessTotal,
      authTimeoutsTotal: this._authTimeoutsTotal,
      orchestratorFailuresTotal: this._orchestratorFailuresTotal,
      latencySamplesTotal: this._latencySamplesTotal,
      latencyE2eUnavailableTotal: this._latencyE2eUnavailableTotal,
      latencyE2eNegativeTotal: this._latencyE2eNegativeTotal,
      latencyUnmatchedChunkTotal: this._latencyUnmatchedChunkTotal,
      upstreamStateTransitions: [...this._upstreamStateTransitions].map(
        ([key, count]) => {
          // Same cast as `wsCloses` below: the label map is keyed by a joined
          // string, so the parts come back as `string` even though every
          // writer is typed.
          const [from = '', to = ''] = key.split(LABEL_SEPARATOR);
          return {
            from: from as UpstreamState,
            to: to as UpstreamState,
            count,
          };
        },
      ),
      wsCloses: [...this._wsCloses].map(([key, count]) => {
        const [code = '', reason = '', role = '', initiator = ''] =
          key.split(LABEL_SEPARATOR);
        return {
          code: Number(code),
          reason,
          role: role as ConnectionRole,
          initiator: initiator as CloseInitiator,
          count,
        };
      }),
      authFailures: [...this._authFailures].map(([reason, count]) => ({
        reason,
        count,
      })),
      // Freshly summarized, so a snapshot taken now keeps the numbers it was
      // taken with even as more samples arrive.
      latency: this._latency.series(),
    };
  }
}
