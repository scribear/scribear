import type { Session } from '@scribear/session-manager-schema';

export function buildSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'session-1',
    roomUid: 'room-1',
    name: 'CS 225 Lecture',
    type: 'SCHEDULED',
    scheduledSessionUid: null,
    scheduledStartTime: '2026-08-01T14:00:00.000Z',
    scheduledEndTime: '2026-08-01T14:50:00.000Z',
    startOverride: null,
    endOverride: null,
    effectiveStart: '2026-08-01T14:00:00.000Z',
    effectiveEnd: '2026-08-01T14:50:00.000Z',
    joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}
