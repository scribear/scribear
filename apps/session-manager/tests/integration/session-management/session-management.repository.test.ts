import { beforeEach, describe, expect } from 'vitest';

import { SessionManagementRepository } from '#src/server/features/session-management/session-management.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'test-api-key' };

describe('SessionManagementRepository', () => {
  const dbContext = useDb(['session_events', 'sessions', 'devices']);
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
      );

      // Assert
      expect(startEvent.event_type).toBe('START_SESSION');
      expect(startEvent.timestamp).toEqual(startTime);
      expect(endEvent.event_type).toBe('END_SESSION');
      expect(endEvent.timestamp).toEqual(endTime);
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
      );

      // Assert
      expect(startEvent.session_id).toBe(session.id);
      expect(endEvent.session_id).toBe(session.id);

      const events = await dbContext.db
        .selectFrom('session_events')
        .selectAll()
        .where('session_id', '=', session.id)
        .execute();

      expect(events).toHaveLength(2);
      expect(events.every((e) => e.device_id === deviceId)).toBe(true);
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
      );

      // Act – window ends before the event
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
      );

      // Act – skip the startEvent by passing its id as afterEventId
      const result = await repository.getNextSessionEvent(
        deviceId,
        startEvent.id,
        new Date(endTime.getTime() + 1),
      );

      // Assert
      expect(result).toBeDefined();
      expect(result!.id).toBe(endEvent.id);
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
