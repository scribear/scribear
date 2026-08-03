/**
 * Estimates the offset between a local clock and a remote clock using
 * Cristian's algorithm, so timestamps taken locally can be translated into the
 * remote clock's domain.
 *
 * For each probe the caller records three timestamps: `t0` (local time the
 * probe was sent), `t1` (remote time when the remote handled it, echoed back),
 * and `t3` (local time the reply arrived). Assuming symmetric network delay,
 * the remote clock at reply time is `t1 + rtt/2`, giving
 * `offset = t1 - (t0 + t3) / 2` and `rtt = t3 - t0`.
 *
 * Network jitter makes individual samples noisy, so the estimate uses the
 * sample with the smallest round-trip time from a sliding window of recent
 * probes - the lowest-RTT sample is the least distorted by queueing delay, and
 * the window lets the estimate track slow clock drift over a long session.
 */

interface ClockSyncSample {
  offsetMs: number;
  rttMs: number;
}

const DEFAULT_MAX_SAMPLES = 8;

export class ClockSync {
  private _samples: ClockSyncSample[] = [];
  private _maxSamples: number;

  public constructor(maxSamples: number = DEFAULT_MAX_SAMPLES) {
    this._maxSamples = Math.max(1, maxSamples);
  }

  /**
   * Record one probe round-trip. Timestamps are in milliseconds. A sample with
   * a negative round-trip time is discarded as impossible (clock stepped
   * mid-probe).
   */
  public record(t0: number, t1: number, t3: number): void {
    const rttMs = t3 - t0;
    if (!(rttMs >= 0)) return;
    const offsetMs = t1 - (t0 + t3) / 2;
    this._samples.push({ offsetMs, rttMs });
    if (this._samples.length > this._maxSamples) {
      this._samples.shift();
    }
  }

  /** Whether at least one usable sample has been recorded. */
  public get hasSample(): boolean {
    return this._samples.length > 0;
  }

  /** Best current offset estimate (remote - local) in ms, or null if none. */
  public get offsetMs(): number | null {
    return this._best()?.offsetMs ?? null;
  }

  /**
   * Translate a local-clock timestamp into the remote clock's domain, or null
   * if no offset has been estimated yet.
   */
  public toRemote(localMs: number): number | null {
    const best = this._best();
    return best === null ? null : localMs + best.offsetMs;
  }

  /** Drop all samples, e.g. on reconnect to a possibly different server. */
  public reset(): void {
    this._samples = [];
  }

  private _best(): ClockSyncSample | null {
    let best: ClockSyncSample | null = null;
    for (const sample of this._samples) {
      if (best === null || sample.rttMs < best.rttMs) {
        best = sample;
      }
    }
    return best;
  }
}
