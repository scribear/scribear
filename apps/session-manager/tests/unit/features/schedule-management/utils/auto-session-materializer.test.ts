import { describe, expect, it } from 'vitest';

import { materializeAutoSessions } from '#src/server/features/schedule-management/utils/auto-session-materializer.js';
import type { NonAutoSession } from '#src/server/features/schedule-management/utils/auto-session-materializer.js';

const MIN_DURATION = 60; // seconds

function session(startIso: string, endIso: string): NonAutoSession {
  return {
    effectiveStart: new Date(startIso),
    effectiveEnd: new Date(endIso),
  };
}

function window(
  startIso: string,
  endIso: string,
  uid = 'window-1',
): { uid: string; start: Date; end: Date } {
  return { uid, start: new Date(startIso), end: new Date(endIso) };
}

describe('materializeAutoSessions', () => {
  describe('no active windows', () => {
    it('returns empty regardless of non-auto sessions', () => {
      // Arrange
      const now = new Date('2024-06-03T09:00:00Z');

      // Act
      const result = materializeAutoSessions([], [], now, MIN_DURATION);

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  describe('single active window, no non-auto sessions', () => {
    it('produces one slot covering the entire window', () => {
      // Arrange
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];

      // Act
      const result = materializeAutoSessions([], windows, now, MIN_DURATION);

      // Assert - slot starts at now (window already started), ends at window end
      expect(result).toHaveLength(1);
      expect(result[0]!.startTime).toEqual(now);
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
    });

    it('starts at window start when now is before the window', () => {
      // Arrange
      const now = new Date('2024-06-03T07:00:00Z');
      const windows = [window('2024-06-03T09:00:00Z', '2024-06-03T17:00:00Z')];

      // Act
      const result = materializeAutoSessions([], windows, now, MIN_DURATION);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
    });

    it('returns empty when the window is entirely in the past', () => {
      // Arrange
      const now = new Date('2024-06-03T18:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];

      // Act
      const result = materializeAutoSessions([], windows, now, MIN_DURATION);

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  describe('single active window with non-auto sessions', () => {
    it('produces slots before and after a session in the middle', () => {
      // Arrange
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [session('2024-06-03T11:00:00Z', '2024-06-03T12:00:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0]!.startTime).toEqual(now);
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T11:00:00Z'));
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T12:00:00Z'));
      expect(result[1]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
    });

    it('produces only a trailing slot when the session covers the window start', () => {
      // Arrange - active session started before now, ends mid-window
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [session('2024-06-03T07:00:00Z', '2024-06-03T11:00:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert - [now, 11:00] is blocked; trailing slot is [11:00, 17:00]
      expect(result).toHaveLength(1);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T11:00:00Z'));
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
    });

    it('produces only a leading slot when the session covers the window end', () => {
      // Arrange
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [session('2024-06-03T15:00:00Z', '2024-06-03T18:00:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert - session blocks [15:00, 17:00] within the window; leading slot [09:00, 15:00]
      expect(result).toHaveLength(1);
      expect(result[0]!.startTime).toEqual(now);
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T15:00:00Z'));
    });

    it('produces no slots when the session covers the entire window', () => {
      // Arrange
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [session('2024-06-03T07:00:00Z', '2024-06-03T18:00:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  describe('multiple active windows', () => {
    it('produces slots within each window independently', () => {
      // Arrange - two windows — morning and afternoon
      const now = new Date('2024-06-03T07:00:00Z');
      const windows = [
        window('2024-06-03T09:00:00Z', '2024-06-03T12:00:00Z', 'win-morning'),
        window('2024-06-03T14:00:00Z', '2024-06-03T17:00:00Z', 'win-afternoon'),
      ];

      // Act
      const result = materializeAutoSessions([], windows, now, MIN_DURATION);

      // Assert - one slot per window, each carrying the correct windowUid
      expect(result).toHaveLength(2);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T12:00:00Z'));
      expect(result[0]!.windowUid).toBe('win-morning');
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T14:00:00Z'));
      expect(result[1]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
      expect(result[1]!.windowUid).toBe('win-afternoon');
    });

    it('handles windows provided in unsorted order', () => {
      // Arrange - windows in reverse order
      const now = new Date('2024-06-03T07:00:00Z');
      const windows = [
        window('2024-06-03T14:00:00Z', '2024-06-03T17:00:00Z', 'win-afternoon'),
        window('2024-06-03T09:00:00Z', '2024-06-03T12:00:00Z', 'win-morning'),
      ];

      // Act
      const result = materializeAutoSessions([], windows, now, MIN_DURATION);

      // Assert - sorted order is applied; windowUids match the windows, not the input order
      expect(result).toHaveLength(2);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.windowUid).toBe('win-morning');
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T14:00:00Z'));
      expect(result[1]!.windowUid).toBe('win-afternoon');
    });

    it('a session spanning the gap between windows blocks only within each window', () => {
      // Arrange - session runs 11:00-15:00, spanning the gap between 09-12 and 14-17 windows
      const now = new Date('2024-06-03T07:00:00Z');
      const windows = [
        window('2024-06-03T09:00:00Z', '2024-06-03T12:00:00Z', 'win-morning'),
        window('2024-06-03T14:00:00Z', '2024-06-03T17:00:00Z', 'win-afternoon'),
      ];
      const sessions = [session('2024-06-03T11:00:00Z', '2024-06-03T15:00:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert - [09:00, 11:00] in first window; [15:00, 17:00] in second window
      expect(result).toHaveLength(2);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T11:00:00Z'));
      expect(result[0]!.windowUid).toBe('win-morning');
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T15:00:00Z'));
      expect(result[1]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
      expect(result[1]!.windowUid).toBe('win-afternoon');
    });

    it('sessions outside all windows are ignored', () => {
      // Arrange - session runs 12:30-13:30 — entirely in the gap between windows
      const now = new Date('2024-06-03T07:00:00Z');
      const windows = [
        window('2024-06-03T09:00:00Z', '2024-06-03T12:00:00Z'),
        window('2024-06-03T14:00:00Z', '2024-06-03T17:00:00Z'),
      ];
      const sessions = [session('2024-06-03T12:30:00Z', '2024-06-03T13:30:00Z')];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert - both windows are unaffected
      expect(result).toHaveLength(2);
      expect(result[0]!.startTime).toEqual(new Date('2024-06-03T09:00:00Z'));
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T12:00:00Z'));
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T14:00:00Z'));
      expect(result[1]!.endTime).toEqual(new Date('2024-06-03T17:00:00Z'));
    });
  });

  describe('minimum duration filtering', () => {
    it('omits interior gaps shorter than minDurationSeconds', () => {
      // Arrange - 30-second gap between two sessions within the window
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [
        session('2024-06-03T11:00:00Z', '2024-06-03T12:00:00Z'),
        session('2024-06-03T12:00:30Z', '2024-06-03T13:00:00Z'),
      ];

      // Act
      const result = materializeAutoSessions(
        sessions,
        windows,
        now,
        MIN_DURATION,
      );

      // Assert - 30s gap is omitted; leading and trailing slots are kept
      expect(result).toHaveLength(2);
      expect(result[0]!.endTime).toEqual(new Date('2024-06-03T11:00:00Z'));
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T13:00:00Z'));
    });

    it('includes interior gaps exactly equal to minDurationSeconds', () => {
      // Arrange - exactly 60s gap
      const now = new Date('2024-06-03T09:00:00Z');
      const windows = [window('2024-06-03T08:00:00Z', '2024-06-03T17:00:00Z')];
      const sessions = [
        session('2024-06-03T11:00:00Z', '2024-06-03T12:00:00Z'),
        session('2024-06-03T12:01:00Z', '2024-06-03T13:00:00Z'),
      ];

      // Act
      const result = materializeAutoSessions(sessions, windows, now, 60);

      // Assert - 60s gap qualifies
      expect(result).toHaveLength(3);
      expect(result[1]!.startTime).toEqual(new Date('2024-06-03T12:00:00Z'));
      expect(result[1]!.endTime).toEqual(new Date('2024-06-03T12:01:00Z'));
    });
  });
});
