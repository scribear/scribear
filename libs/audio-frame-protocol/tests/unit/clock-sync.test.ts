import { describe, expect, it } from 'vitest';

import { ClockSync } from '#src/index.js';

describe('ClockSync', () => {
  it('starts with no sample', () => {
    const cs = new ClockSync();
    expect(cs.hasSample).toBe(false);
    expect(cs.offsetMs).toBeNull();
    expect(cs.toRemote(1000)).toBeNull();
  });

  it('estimates a constant offset with symmetric delay', () => {
    const cs = new ClockSync();
    // Remote clock is +1000ms ahead. Probe sent at t0=100 (local), round trip
    // 20ms so reply arrives t3=120; remote handled it at the midpoint + offset:
    // t1 = ((100 + 120) / 2) + 1000 = 1110.
    cs.record(100, 1110, 120);
    expect(cs.offsetMs).toBe(1000);
    expect(cs.toRemote(5000)).toBe(6000);
  });

  it('prefers the lowest-RTT sample', () => {
    const cs = new ClockSync();
    // A jittery sample (rtt 200) that skews the naive offset...
    cs.record(0, 1000, 200); // offset = 1000 - 100 = 900
    // ...and a clean sample (rtt 10) revealing the true +1000 offset.
    cs.record(0, 1005, 10); // offset = 1005 - 5 = 1000
    expect(cs.offsetMs).toBe(1000);
  });

  it('discards impossible (negative-RTT) samples', () => {
    const cs = new ClockSync();
    cs.record(100, 1000, 50); // t3 < t0
    expect(cs.hasSample).toBe(false);
  });

  it('evicts old samples beyond the window so drift can be tracked', () => {
    const cs = new ClockSync(2);
    cs.record(0, 1000, 10); // offset 995, rtt 10  (oldest)
    cs.record(0, 2000, 20); // offset 1990, rtt 20
    cs.record(0, 3000, 20); // offset 2990, rtt 20
    // Window holds the last two; the rtt-10 sample was evicted, so the best of
    // the remaining (both rtt 20) reflects the newer offsets, not the stale one.
    expect(cs.offsetMs).toBe(1990);
  });

  it('reset clears samples', () => {
    const cs = new ClockSync();
    cs.record(0, 1000, 10);
    cs.reset();
    expect(cs.hasSample).toBe(false);
  });
});
