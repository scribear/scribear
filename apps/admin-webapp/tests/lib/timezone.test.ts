import { describe, expect } from 'vitest';

import { browserTimeZone, formatInTimeZone } from '#src/lib/timezone';

describe('formatInTimeZone', (it) => {
  it('renders the same instant differently in two zones', () => {
    // Arrange - 15:30 UTC is 10:30 in Chicago (CDT) on this date.
    const iso = '2026-07-01T15:30:00.000Z';

    // Act
    const chicago = formatInTimeZone(iso, 'America/Chicago');
    const utc = formatInTimeZone(iso, 'UTC');

    // Assert
    expect(chicago).toContain('10:30');
    expect(utc).toContain('3:30');
  });

  it('falls back to browser formatting for a zone Intl rejects', () => {
    // Arrange - a bad `rooms.timezone` must degrade to a readable time rather
    // than throw and blank the table that called it.
    const iso = '2026-07-01T15:30:00.000Z';

    // Act
    const out = formatInTimeZone(iso, 'Not/AZone');

    // Assert
    expect(out).toBe(new Date(iso).toLocaleString());
  });
});

describe('browserTimeZone', (it) => {
  it('returns an IANA zone name', () => {
    // Act
    const zone = browserTimeZone();

    // Assert - shape only; the value is whatever machine runs the suite.
    expect(zone).toMatch(/^[A-Za-z]+(\/[A-Za-z_+-]+)*$/);
    expect(zone.length).toBeGreaterThan(0);
  });
});
