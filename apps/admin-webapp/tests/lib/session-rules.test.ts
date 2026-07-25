import { describe, expect, it } from 'vitest';

import { sessionTypeColor, sessionWindowState } from '#src/lib/session-rules';

describe('sessionTypeColor', () => {
  it('returns info for SCHEDULED', () => {
    expect(sessionTypeColor('SCHEDULED')).toBe('info');
  });

  it('returns success for ON_DEMAND', () => {
    expect(sessionTypeColor('ON_DEMAND')).toBe('success');
  });

  it('returns default for AUTO', () => {
    expect(sessionTypeColor('AUTO')).toBe('default');
  });
});

describe('sessionWindowState', () => {
  const START = '2026-07-25T14:00:00.000Z';
  const END = '2026-07-25T15:00:00.000Z';
  const at = (iso: string) => Date.parse(iso);

  it('is before when now precedes effectiveStart', () => {
    expect(
      sessionWindowState(
        { effectiveStart: START, effectiveEnd: END },
        at('2026-07-25T13:59:59.000Z'),
      ),
    ).toBe('before');
  });

  it('is within between start and end', () => {
    expect(
      sessionWindowState(
        { effectiveStart: START, effectiveEnd: END },
        at('2026-07-25T14:30:00.000Z'),
      ),
    ).toBe('within');
  });

  it('is after once now passes effectiveEnd', () => {
    expect(
      sessionWindowState(
        { effectiveStart: START, effectiveEnd: END },
        at('2026-07-25T15:00:01.000Z'),
      ),
    ).toBe('after');
  });

  it('treats an open-ended session as within forever after it starts', () => {
    // effectiveEnd null means no scheduled end; such a session must never read
    // as "ended", or its audio health would go quiet while it is still running.
    expect(
      sessionWindowState(
        { effectiveStart: START, effectiveEnd: null },
        at('2027-01-01T00:00:00.000Z'),
      ),
    ).toBe('within');
  });

  it('includes the exact boundaries', () => {
    const window = { effectiveStart: START, effectiveEnd: END };

    expect(sessionWindowState(window, at(START))).toBe('within');
    expect(sessionWindowState(window, at(END))).toBe('within');
  });

  it('falls through to within on an unparseable timestamp', () => {
    // Better to show telemetry that may be real than to suppress a live
    // session's audio health because a date failed to parse.
    expect(
      sessionWindowState(
        { effectiveStart: 'not-a-date', effectiveEnd: null },
        at(START),
      ),
    ).toBe('within');
  });
});
