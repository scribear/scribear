/**
 * Bounded sample windows for latency percentiles (monitoring plan B1.4).
 *
 * Node Server already publishes every latency sample to the client that asked
 * for it, but nothing kept them: the moment a sample was fanned out it was
 * gone, so "how slow is this room right now?" could only be answered by a
 * client that happened to be watching. These windows retain the recent samples
 * server-side so `GET /status` can report p50/p95/p99.
 *
 * Raw samples are retained rather than Prometheus-style bucket counts because
 * the dashboard's latency panels are specified in terms of exact percentiles
 * (PLAN-MONITORING-DASHBOARD.md §7 B1.4), and buckets would only give
 * interpolated ones. The summary shape deliberately matches the histogram
 * series transcription-service reports from `GET /metrics/status`, so the two
 * services' latency panels can share a renderer.
 *
 * Nothing is persisted and nothing is time-windowed: a window describes the
 * last N observations, however long ago they arrived. A session that goes
 * quiet therefore keeps reporting its last N samples rather than decaying to
 * empty - acceptable because the per-session windows die with the session, and
 * the process-wide ones are read alongside `latencySamplesTotal`, which shows
 * whether samples are still arriving at all.
 */

/**
 * Summary statistics over a {@link LatencyWindow}.
 *
 * `count` and `sum` are lifetime totals and behave like counters. Every other
 * field describes only the retained ring, so it is a gauge of recent behaviour
 * - after the ring wraps, `mean` and `sum / count` no longer agree, and that is
 * intended.
 */
export interface LatencySummary {
  /** Observations since process start. */
  count: number;
  /** Sum of every observation since process start, in milliseconds. */
  sum: number;
  /** Observations currently retained, i.e. what the percentiles describe. */
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * A fixed-capacity ring of recent observations.
 *
 * Implemented as a circular buffer with a write cursor rather than
 * push-and-shift: `shift()` on a full 4096-element array is O(n) per sample,
 * and latency samples arrive on every transcript of every session.
 */
export class LatencyWindow {
  private readonly _capacity: number;
  private _ring: number[] = [];
  private _next = 0;
  private _count = 0;
  private _sum = 0;

  constructor(capacity: number) {
    this._capacity = Math.max(1, capacity);
  }

  observe(valueMs: number): void {
    this._count += 1;
    this._sum += valueMs;
    if (this._ring.length < this._capacity) {
      this._ring.push(valueMs);
      return;
    }
    this._ring[this._next] = valueMs;
    this._next = (this._next + 1) % this._capacity;
  }

  /**
   * Statistics over the retained samples, or `null` when nothing has been
   * observed. Null rather than a zero-filled summary on purpose: a p95 of 0 is
   * indistinguishable from a genuinely instant pipeline, and would light up a
   * dashboard panel green for a session that has produced no transcripts at
   * all.
   *
   * The returned object shares no state with this window, so a snapshot taken
   * now does not change as later samples arrive.
   */
  summary(): LatencySummary | null {
    if (this._ring.length === 0) return null;
    const sorted = [...this._ring].sort((a, b) => a - b);
    let windowSum = 0;
    for (const value of sorted) windowSum += value;
    return {
      count: this._count,
      sum: this._sum,
      sampleCount: sorted.length,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      mean: windowSum / sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }
}

/**
 * Nearest-rank percentile over a pre-sorted array - the same definition the
 * monitoring sidecar and transcription-service use, so a p95 means the same
 * thing everywhere in the fleet.
 */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}
