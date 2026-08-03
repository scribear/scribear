/**
 * Minimal in-memory metric primitives.
 *
 * Deliberately hand-rolled rather than pulling in `prom-client`: the sidecar
 * needs two output shapes (Prometheus text AND a JSON snapshot for the admin
 * SPA), plus rolling-window rates for alert evaluation, none of which
 * `prom-client` exposes cleanly. The surface here is small enough that owning
 * it is cheaper than adapting a library.
 *
 * Nothing is persisted. Restarting the sidecar zeroes every metric; that is an
 * accepted trade (see 2026-07-19-01-PLAN-MONITORING-DASHBOARD.md §9 item 1 —
 * "in-memory only, live snapshot", trends deferred).
 */

/** Label set attached to a single metric series. */
export type Labels = Readonly<Record<string, string>>;

/**
 * Serializes a label set into a stable series key. Keys are sorted so that
 * `{a,b}` and `{b,a}` collapse to the same series.
 */
export function seriesKey(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

/** Parses a series key produced by {@link seriesKey} back into labels. */
export function parseSeriesKey(key: string): Labels {
  if (key === '') return {};
  const out: Record<string, string> = {};
  for (const part of key.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** A single observation retained for rolling-rate computation. */
interface WindowSample {
  atMs: number;
  value: number;
}

/**
 * Monotonic counter with labels, plus a bounded rolling window of recent
 * increments so alert rules can ask "how many in the last N seconds?".
 *
 * The window is what makes churn/error-rate alerting possible without a TSDB.
 * Samples older than `windowMs` are dropped lazily on read and write, so memory
 * is bounded by the arrival rate within the window rather than by uptime.
 */
export class Counter {
  readonly name: string;
  readonly help: string;

  private _values = new Map<string, number>();
  private _window = new Map<string, WindowSample[]>();
  private _windowMs: number;

  constructor(name: string, help: string, windowMs = 300_000) {
    this.name = name;
    this.help = help;
    this._windowMs = windowMs;
  }

  inc(labels: Labels = {}, value = 1, nowMs: number = Date.now()): void {
    const key = seriesKey(labels);
    this._values.set(key, (this._values.get(key) ?? 0) + value);

    const samples = this._window.get(key) ?? [];
    samples.push({ atMs: nowMs, value });
    this._prune(samples, nowMs);
    this._window.set(key, samples);
  }

  get(labels: Labels = {}): number {
    return this._values.get(seriesKey(labels)) ?? 0;
  }

  /** Total across every series, ignoring labels. */
  total(): number {
    let sum = 0;
    for (const v of this._values.values()) sum += v;
    return sum;
  }

  /**
   * Sum of increments within the trailing `sinceMs` window, across all series
   * whose labels match every entry of `match` (a subset match, so
   * `rate({service:'node-server'})` aggregates over all other label values).
   */
  windowCount(
    match: Labels = {},
    sinceMs: number = this._windowMs,
    nowMs: number = Date.now(),
  ): number {
    const cutoff = nowMs - sinceMs;
    let sum = 0;
    for (const [key, samples] of this._window) {
      if (!matchesSubset(parseSeriesKey(key), match)) continue;
      this._prune(samples, nowMs);
      for (const s of samples) if (s.atMs >= cutoff) sum += s.value;
    }
    return sum;
  }

  /** Every series currently held, for export. */
  entries(): { labels: Labels; value: number }[] {
    return [...this._values].map(([key, value]) => ({
      labels: parseSeriesKey(key),
      value,
    }));
  }

  private _prune(samples: WindowSample[], nowMs: number): void {
    const cutoff = nowMs - this._windowMs;
    let drop = 0;
    while (drop < samples.length) {
      const sample = samples[drop];
      if (sample === undefined || sample.atMs >= cutoff) break;
      drop++;
    }
    if (drop > 0) samples.splice(0, drop);
  }
}

/** Point-in-time value with labels. Last write wins. */
export class Gauge {
  readonly name: string;
  readonly help: string;

  private _values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(labels: Labels, value: number): void {
    this._values.set(seriesKey(labels), value);
  }

  get(labels: Labels = {}): number | undefined {
    return this._values.get(seriesKey(labels));
  }

  /**
   * Forgets a series entirely.
   *
   * A gauge describing something that no longer exists — a session that ended,
   * say — must disappear rather than freeze at its last value, which would read
   * as "still there, unchanged" forever. There is no counter equivalent on
   * purpose: counters are monotonic and deleting one would break differencing.
   */
  delete(labels: Labels): void {
    this._values.delete(seriesKey(labels));
  }

  entries(): { labels: Labels; value: number }[] {
    return [...this._values].map(([key, value]) => ({
      labels: parseSeriesKey(key),
      value,
    }));
  }
}

/** Summary statistics derived from a histogram's retained observations. */
export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Histogram that retains a bounded ring of raw observations so exact
 * percentiles can be reported.
 *
 * Bucket counts alone (the Prometheus model) would give only interpolated
 * quantiles, and the dashboard's latency panels are specified in terms of
 * p50/p95/p99. Retaining raw samples is affordable here because the retention
 * cap is per-series and small; it is NOT a general-purpose design.
 */
export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: readonly number[];

  private _samples = new Map<string, number[]>();
  private _sums = new Map<string, number>();
  private _counts = new Map<string, number>();
  private _maxSamples: number;

  constructor(
    name: string,
    help: string,
    buckets: readonly number[],
    maxSamples = 4096,
  ) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
    this._maxSamples = maxSamples;
  }

  observe(value: number, labels: Labels = {}): void {
    const key = seriesKey(labels);
    const samples = this._samples.get(key) ?? [];
    samples.push(value);
    // Ring behaviour: drop the oldest observation once the cap is hit, so
    // percentiles describe recent behaviour rather than all of history.
    if (samples.length > this._maxSamples) samples.shift();
    this._samples.set(key, samples);
    this._sums.set(key, (this._sums.get(key) ?? 0) + value);
    this._counts.set(key, (this._counts.get(key) ?? 0) + 1);
  }

  summary(labels: Labels = {}): HistogramSummary | undefined {
    const samples = this._samples.get(seriesKey(labels));
    if (samples === undefined || samples.length === 0) return undefined;
    return summarize(samples, this._sums.get(seriesKey(labels)) ?? 0);
  }

  /** Cumulative bucket counts, in Prometheus `le` semantics. */
  bucketCounts(labels: Labels = {}): { le: number; count: number }[] {
    const samples = this._samples.get(seriesKey(labels)) ?? [];
    return this.buckets.map((le) => ({
      le,
      count: samples.filter((s) => s <= le).length,
    }));
  }

  seriesLabels(): Labels[] {
    return [...this._samples.keys()].map(parseSeriesKey);
  }

  count(labels: Labels = {}): number {
    return this._counts.get(seriesKey(labels)) ?? 0;
  }

  sum(labels: Labels = {}): number {
    return this._sums.get(seriesKey(labels)) ?? 0;
  }
}

function summarize(samples: number[], sum: number): HistogramSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    sum,
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/** Nearest-rank percentile over a pre-sorted array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? Number.NaN;
}

/** True when `labels` contains every key/value pair in `match`. */
export function matchesSubset(labels: Labels, match: Labels): boolean {
  for (const [k, v] of Object.entries(match)) {
    if (labels[k] !== v) return false;
  }
  return true;
}
