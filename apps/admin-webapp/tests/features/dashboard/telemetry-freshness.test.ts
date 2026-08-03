import { describe, expect } from 'vitest';

import {
  FLEET_STALE_AFTER_MS,
  deriveFreshness,
  formatAge,
  freshnessChipLabel,
} from '#src/features/dashboard/telemetry-freshness';
import type { FleetPollState } from '#src/features/dashboard/use-fleet';

const NOW = 1_700_000_000_000;

function degraded(
  overrides: Partial<Extract<FleetPollState, { status: 'degraded' }>> = {},
) {
  return {
    status: 'degraded' as const,
    code: 'TELEMETRY_DEGRADED',
    message: 'Could not read live fleet telemetry.',
    lastSuccessAt: NOW - 4_000,
    consecutiveFailures: 1,
    ...overrides,
  };
}

describe('formatAge', (it) => {
  it('resolves to whole seconds under a minute', () => {
    expect(formatAge(0)).toBe('0s');
    expect(formatAge(3_400)).toBe('3s');
    expect(formatAge(59_999)).toBe('59s');
  });

  it('switches to minutes and seconds, then to hours and minutes', () => {
    expect(formatAge(60_000)).toBe('1m 0s');
    expect(formatAge(134_000)).toBe('2m 14s');
    expect(formatAge(3_600_000)).toBe('1h 0m');
    expect(formatAge(7_500_000)).toBe('2h 5m');
  });
});

describe('deriveFreshness', (it) => {
  it('says nothing at all while the very first read is in flight', () => {
    // The "waiting" case must not borrow the vocabulary of a fault
    // (PLAN §10.4): a panel that has not loaded yet is not degraded.
    const freshness = deriveFreshness({ status: 'loading' }, NOW);

    expect(freshness.severity).toBe('ok');
    expect(freshness.stale).toBe(false);
    expect(freshness.headline).toBeNull();
  });

  it('is ok, and not stale, for a read that landed within the threshold', () => {
    const freshness = deriveFreshness(
      { status: 'ok', lastSuccessAt: NOW - 2_000 },
      NOW,
    );

    expect(freshness.severity).toBe('ok');
    expect(freshness.stale).toBe(false);
    expect(freshness.ageMs).toBe(2_000);
    expect(freshness.headline).toBeNull();
  });

  it('warns and marks stale on a degraded read, keeping the snapshot age', () => {
    // The §4.4 regression in one assertion: TELEMETRY_DEGRADED used to fall
    // through with no chip, no toast and no staleness marker at all.
    const freshness = deriveFreshness(degraded(), NOW);

    expect(freshness.severity).toBe('warning');
    expect(freshness.stale).toBe(true);
    expect(freshness.ageMs).toBe(4_000);
    expect(freshness.lastSuccessAt).toBe(NOW - 4_000);
    expect(freshness.headline).toMatch(/not the current state of the fleet/i);
    expect(freshness.cause).toBe('Could not read live fleet telemetry.');
    expect(freshness.nextAction).not.toBeNull();
  });

  it('escalates a degraded read to error once the data outlives the stale threshold', () => {
    const freshness = deriveFreshness(
      degraded({ lastSuccessAt: NOW - FLEET_STALE_AFTER_MS }),
      NOW,
    );

    expect(freshness.severity).toBe('error');
    expect(freshness.stale).toBe(true);
    expect(freshness.headline).toMatch(/do not read this grid as current/i);
  });

  it('treats an old snapshot as stale even when no read has failed', () => {
    // A hidden tab pauses the poll and a hung request never rejects, so a
    // status-only rule would call both of these live.
    const freshness = deriveFreshness(
      { status: 'ok', lastSuccessAt: NOW - 10 * FLEET_STALE_AFTER_MS },
      NOW,
    );

    expect(freshness.severity).toBe('warning');
    expect(freshness.stale).toBe(true);
    expect(freshness.headline).toMatch(/older than one poll cycle/i);
  });

  it('reports an error, not an empty panel, when no read has ever succeeded', () => {
    const freshness = deriveFreshness(
      degraded({ lastSuccessAt: null, consecutiveFailures: 3 }),
      NOW,
    );

    expect(freshness.severity).toBe('error');
    // Nothing is on screen to mark as stale — the point is that the emptiness
    // is a failure, not an idle fleet.
    expect(freshness.stale).toBe(false);
    expect(freshness.ageMs).toBeNull();
    expect(freshness.headline).toMatch(/does not mean the fleet is idle/i);
  });

  it('keeps the ticking age out of the announced sentence', () => {
    // The banner is assertive; a relative age inside it would re-announce
    // itself every second to a screen-reader user.
    const freshness = deriveFreshness(degraded(), NOW);

    expect(freshness.headline).not.toMatch(/\d+s\b/);
    expect(freshness.headline).not.toMatch(/\d+m /);
  });

  it('carries the unavailable message without inventing a staleness claim', () => {
    const freshness = deriveFreshness(
      { status: 'unavailable', message: 'REDIS_URL unset.' },
      NOW,
    );

    expect(freshness.stale).toBe(false);
    expect(freshness.ageMs).toBeNull();
    expect(freshness.cause).toBe('REDIS_URL unset.');
  });
});

describe('freshnessChipLabel', (it) => {
  it('says how fresh the data is in words, never by colour alone', () => {
    const fresh = deriveFreshness(
      { status: 'ok', lastSuccessAt: NOW - 3_000 },
      NOW,
    );

    expect(freshnessChipLabel(fresh)).toBe('updated 3s ago');
  });

  it('says the data is not updating, and how old it is, when stale', () => {
    const stale = deriveFreshness(
      degraded({ lastSuccessAt: NOW - 134_000 }),
      NOW,
    );

    expect(freshnessChipLabel(stale)).toBe('not updating · 2m 14s old');
  });

  it('distinguishes "no data yet" from "no data at all"', () => {
    expect(
      freshnessChipLabel(deriveFreshness({ status: 'loading' }, NOW)),
    ).toBe('waiting for first update');
  });
});
