import { describe, expect, it } from 'vitest';

import { materializeWindow } from '#src/server/features/schedule-management/utils/window-materializer.js';
import type { AutoSessionWindow } from '#src/server/features/schedule-management/schedule-management.repository.js';

const TZ_UTC = 'UTC';

function makeWindow(overrides: Partial<AutoSessionWindow>): AutoSessionWindow {
  const activeStart = overrides.activeStart ?? new Date('2024-01-01T00:00:00Z');
  return {
    uid: 'window-1',
    roomUid: 'room-1',
    localStartTime: '09:00:00',
    localEndTime: '10:00:00',
    daysOfWeek: ['MON'],
    joinCodeScopes: ['SEND_AUDIO'],
    transcriptionProviderId: 'provider-1',
    transcriptionStreamConfig: null,
    activeStart,
    activeEnd: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('materializeWindow', () => {
  describe('days mapping', () => {
    it('passes daysOfWeek through to the synthetic WEEKLY schedule', () => {
      // Arrange - fires TUE/THU, 14:00-14:30 UTC
      const window = makeWindow({
        localStartTime: '14:00:00',
        localEndTime: '14:30:00',
        daysOfWeek: ['TUE', 'THU'],
      });

      // Act
      const result = materializeWindow(
        window,
        TZ_UTC,
        new Date('2024-06-03T00:00:00Z'), // Mon
        new Date('2024-06-10T00:00:00Z'), // Next Mon (exclusive)
      );

      // Assert - only Tue and Thu occurrences, tagged with the window's uid
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        windowUid: 'window-1',
        startUtc: new Date('2024-06-04T14:00:00Z'), // Tue
        endUtc: new Date('2024-06-04T14:30:00Z'),
      });
      expect(result[1]).toEqual({
        windowUid: 'window-1',
        startUtc: new Date('2024-06-06T14:00:00Z'), // Thu
        endUtc: new Date('2024-06-06T14:30:00Z'),
      });
    });
  });

  describe('activeStart clipping', () => {
    it('drops an occurrence whose computed start falls before activeStart', () => {
      // Arrange - activeStart lands mid-day, after the occurrence's local start
      // time on that same day, so the occurrence must not be included.
      const window = makeWindow({
        activeStart: new Date('2024-06-03T14:00:00Z'), // Mon 14:00 UTC
        localStartTime: '09:00:00', // Mon 09:00 UTC - before activeStart
        localEndTime: '10:00:00',
        daysOfWeek: ['MON'],
      });

      // Act
      const result = materializeWindow(
        window,
        TZ_UTC,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-06-30T00:00:00Z'),
      );

      // Assert - the Mon Jun 3 occurrence is clipped away entirely (its
      // computed start is before activeStart); the later qualifying Mondays
      // within the window (Jun 10, 17, 24) are unaffected by activeStart.
      expect(result).toHaveLength(3);
      expect(result[0]!.startUtc).toEqual(new Date('2024-06-10T09:00:00Z'));
      expect(result[1]!.startUtc).toEqual(new Date('2024-06-17T09:00:00Z'));
      expect(result[2]!.startUtc).toEqual(new Date('2024-06-24T09:00:00Z'));
    });
  });

  describe('midnight-wrap', () => {
    it('produces a cross-midnight occurrence when localEndTime < localStartTime', () => {
      // Arrange - 23:00-01:00 means the window runs from Mon 23:00 to Tue 01:00
      const window = makeWindow({
        localStartTime: '23:00:00',
        localEndTime: '01:00:00',
        daysOfWeek: ['MON'],
      });

      // Act
      const result = materializeWindow(
        window,
        TZ_UTC,
        new Date('2024-06-03T00:00:00Z'),
        new Date('2024-06-10T00:00:00Z'),
      );

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        windowUid: 'window-1',
        startUtc: new Date('2024-06-03T23:00:00Z'),
        endUtc: new Date('2024-06-04T01:00:00Z'),
      });
    });
  });
});
