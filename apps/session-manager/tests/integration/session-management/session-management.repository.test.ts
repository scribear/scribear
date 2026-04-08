import { beforeEach, describe, expect } from 'vitest';

import { SessionManagementRepository } from '#src/server/features/session-management/session-management.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'test-api-key' };

describe('SessionManagementRepository', () => {
  const dbContext = useDb([
    'session_join_codes',
    'session_refresh_tokens',
    'session_events',
    'sessions',
    'devices',
  ]);
  let repository: SessionManagementRepository;

  // Helper to insert an active device and return its id
  async function insertDevice(name = 'test-device') {
    const row = await dbContext.db
      .insertInto('devices')
      .values({
        name,
        is_active: true,
        secret_hash: 'x'.repeat(60),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  beforeEach(() => {
    repository = new SessionManagementRepository(dbContext.dbClient);
  });

  describe('deviceExists', (it) => {
    it('returns true when device exists', async () => {
      // Arrange
      const deviceId = await insertDevice();

      // Act
      const result = await repository.deviceExists(deviceId);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false when device does not exist', async () => {
      // Act
      const result = await repository.deviceExists(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('createSession', (it) => {
    it('inserts a session and returns id', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);

      // Act
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Assert
      expect(session.id).toBeDefined();

      const inserted = await dbContext.db
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();

      expect(inserted.source_device_id).toBe(deviceId);
      expect(inserted.transcription_provider_key).toBe(TEST_PROVIDER_KEY);
    });

    it('stores null join code config when not provided', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);

      // Act
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Assert
      const inserted = await dbContext.db
        .selectFrom('sessions')
        .select(['join_code_length', 'join_code_rotation_enabled'])
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();

      expect(inserted.join_code_length).toBeNull();
      expect(inserted.join_code_rotation_enabled).toBeNull();
    });

    it('stores join code config when provided', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);

      // Act
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        6,
        true,
      );

      // Assert
      const inserted = await dbContext.db
        .selectFrom('sessions')
        .select(['join_code_length', 'join_code_rotation_enabled'])
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();

      expect(inserted.join_code_length).toBe(6);
      expect(inserted.join_code_rotation_enabled).toBe(true);
    });

    it('creates a START_SESSION event and an END_SESSION event', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);

      // Act
      const { startEvent, endEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Assert
      expect(startEvent.event_type).toBe('START_SESSION');
      expect(startEvent.timestamp).toEqual(startTime);
      expect(endEvent).not.toBeNull();
      expect(endEvent!.event_type).toBe('END_SESSION');
      expect(endEvent!.timestamp).toEqual(endTime);
    });

    it('associates events with the correct session and device', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);

      // Act
      const { session, startEvent, endEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Assert
      expect(startEvent.session_id).toBe(session.id);
      expect(endEvent).not.toBeNull();
      expect(endEvent!.session_id).toBe(session.id);

      const events = await dbContext.db
        .selectFrom('session_events')
        .selectAll()
        .where('session_id', '=', session.id)
        .execute();

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.device_id === deviceId)).toBe(true);
    });

    it('creates only a START_SESSION event when endTime is null (indefinite session)', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();

      // Act
      const { session, startEvent, endEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        null,
        null,
        null,
      );

      // Assert
      expect(startEvent.event_type).toBe('START_SESSION');
      expect(endEvent).toBeNull();

      const events = await dbContext.db
        .selectFrom('session_events')
        .selectAll()
        .where('session_id', '=', session.id)
        .execute();

      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('START_SESSION');
    });
  });

  describe('findActiveSessionBySourceDevice', (it) => {
    it('returns undefined when no session exists', async () => {
      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        '00000000-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-000000000001',
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns the session when deviceId and sessionId match an active session', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() - 1000);
      const endTime = new Date(Date.now() + 60_000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        deviceId,
        session.id,
      );

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(session.id);
      expect(result!.transcription_provider_key).toBe(TEST_PROVIDER_KEY);
      expect(result!.transcription_provider_config).toEqual(
        TEST_PROVIDER_CONFIG,
      );
    });

    it('returns undefined when sessionId belongs to a different device', async () => {
      // Arrange
      const deviceId = await insertDevice('device-a');
      const otherDeviceId = await insertDevice('device-b');
      const startTime = new Date(Date.now() - 1000);
      const endTime = new Date(Date.now() + 60_000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        otherDeviceId,
        session.id,
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns undefined when session has expired', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() - 2000);
      const endTime = new Date(Date.now() - 1000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        deviceId,
        session.id,
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns undefined when session has not started yet', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() + 10_000);
      const endTime = new Date(Date.now() + 60_000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        deviceId,
        session.id,
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns the session when end_time is null (indefinite session)', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() - 1000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        null,
        null,
        null,
      );

      // Act
      const result = await repository.findActiveSessionBySourceDevice(
        deviceId,
        session.id,
      );

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(session.id);
    });
  });

  describe('findSessionById', (it) => {
    it('returns the session when it exists', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.findSessionById(session.id);

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(session.id);
      expect(result!.source_device_id).toBe(deviceId);
      expect(result!.transcription_provider_key).toBe(TEST_PROVIDER_KEY);
    });

    it('returns undefined when session does not exist', async () => {
      // Act
      const result = await repository.findSessionById(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('endSession', (it) => {
    it('updates end_time and inserts END_SESSION event', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() - 1000);
      const { session } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        null,
        null,
        null,
      );
      const endTime = new Date();

      // Act
      await repository.endSession(session.id, deviceId, endTime);

      // Assert
      const updated = await dbContext.db
        .selectFrom('sessions')
        .select('end_time')
        .where('id', '=', session.id)
        .executeTakeFirstOrThrow();
      expect(updated.end_time).toEqual(endTime);

      const events = await dbContext.db
        .selectFrom('session_events')
        .selectAll()
        .where('session_id', '=', session.id)
        .where('event_type', '=', 'END_SESSION')
        .execute();
      expect(events).toHaveLength(1);
    });
  });

  describe('getNextSessionEvent', (it) => {
    it('returns undefined when there are no events', async () => {
      // Act
      const result = await repository.getNextSessionEvent(
        '00000000-0000-0000-0000-000000000000',
        null,
        new Date(Date.now() + 60_000),
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns the earliest event within the window', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);
      const { startEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.getNextSessionEvent(
        deviceId,
        null,
        new Date(startTime.getTime() + 1),
      );

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(startEvent.id);
      expect(result!.event_type).toBe('START_SESSION');
    });

    it('returns undefined when the event timestamp is outside the window', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date(Date.now() + 10_000); // 10s in the future
      const endTime = new Date(startTime.getTime() + 60_000);
      await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.getNextSessionEvent(
        deviceId,
        null,
        new Date(startTime.getTime() - 1),
      );

      // Assert
      expect(result).toBeUndefined();
    });

    it('skips events with id <= afterEventId', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);
      const { startEvent, endEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.getNextSessionEvent(
        deviceId,
        startEvent.id,
        new Date(endTime.getTime() + 1),
      );

      // Assert
      expect(result).toBeDefined();
      expect(endEvent).not.toBeNull();
      expect(result!.id).toBe(endEvent!.id);
      expect(result!.event_type).toBe('END_SESSION');
    });

    it('returns events from the beginning when afterEventId is null', async () => {
      // Arrange
      const deviceId = await insertDevice();
      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 60_000);
      const { startEvent } = await repository.createSession(
        deviceId,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        startTime,
        endTime,
        null,
        null,
      );

      // Act
      const result = await repository.getNextSessionEvent(
        deviceId,
        null,
        new Date(startTime.getTime() + 1),
      );

      // Assert
      expect(result!.id).toBe(startEvent.id);
    });
  });
});
