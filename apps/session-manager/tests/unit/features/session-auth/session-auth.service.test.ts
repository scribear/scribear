import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { SessionAuthService } from '#src/server/features/session-auth/session-auth.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const NOW = new Date('2026-04-27T12:00:00.000Z');
const SESSION_UID = 'session-1';
const ROOM_UID = 'room-1';
const DEVICE_UID = 'device-1';

const ACTIVE_SESSION = {
  uid: SESSION_UID,
  roomUid: ROOM_UID,
  joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS' as const],
  effectiveStart: new Date(NOW.getTime() - 60_000),
  effectiveEnd: new Date(NOW.getTime() + 60 * 60_000),
};

const NOT_YET_STARTED_SESSION = {
  ...ACTIVE_SESSION,
  effectiveStart: new Date(NOW.getTime() + 60_000),
};

const ENDED_SESSION = {
  ...ACTIVE_SESSION,
  effectiveEnd: new Date(NOW.getTime() - 60_000),
};

describe('SessionAuthService', () => {
  let mockRepo: {
    db: { transaction: Mock };
    findSessionForAuth: Mock;
    isDeviceInRoom: Mock;
    isDeviceSourceForRoom: Mock;
    findActiveJoinCodes: Mock;
    insertJoinCode: Mock;
    findJoinCodeByCode: Mock;
    insertRefreshToken: Mock;
    findRefreshTokenByUid: Mock;
  };
  let mockHashService: { hash: Mock; verify: Mock };
  let mockTokenService: { sign: Mock; verify: Mock };
  let service: SessionAuthService;

  beforeEach(() => {
    // Stub `db.transaction().execute(fn)` so that fn(trx) is invoked with a
    // sentinel transaction handle and its result is propagated. The repo
    // mocks ignore the handle, but the real service path threads it through.
    const trx = Symbol('trx');
    const transactionStub = {
      execute: vi.fn((fn: (t: unknown) => unknown) => fn(trx)),
    };

    mockRepo = {
      db: { transaction: vi.fn(() => transactionStub) },
      findSessionForAuth: vi.fn(),
      isDeviceInRoom: vi.fn(),
      isDeviceSourceForRoom: vi.fn(),
      findActiveJoinCodes: vi.fn(),
      insertJoinCode: vi.fn(),
      findJoinCodeByCode: vi.fn(),
      insertRefreshToken: vi.fn(),
      findRefreshTokenByUid: vi.fn(),
    };
    mockHashService = { hash: vi.fn(), verify: vi.fn() };
    mockTokenService = { sign: vi.fn(), verify: vi.fn() };

    service = new SessionAuthService(
      createMockLogger() as never,
      mockRepo as never,
      mockHashService as never,
      mockTokenService as never,
    );
  });

  describe('fetchJoinCodes', (it) => {
    it("returns 'SESSION_NOT_FOUND' when the session does not exist", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(undefined);

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      expect(result).toBe('SESSION_NOT_FOUND');
    });

    it("returns 'DEVICE_NOT_IN_SESSION_ROOM' when the device is not in the session room", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(false);

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      expect(result).toBe('DEVICE_NOT_IN_SESSION_ROOM');
    });

    it("returns 'JOIN_CODE_SCOPES_EMPTY' when the session has no join code scopes", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue({
        ...ACTIVE_SESSION,
        joinCodeScopes: [],
      });
      mockRepo.isDeviceInRoom.mockResolvedValue(true);

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      expect(result).toBe('JOIN_CODE_SCOPES_EMPTY');
    });

    it('generates a fresh code when none exist', async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.findActiveJoinCodes.mockResolvedValue([]);
      mockRepo.insertJoinCode.mockImplementation((_db, data) =>
        Promise.resolve(data),
      );

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      expect(result).not.toBe('SESSION_NOT_FOUND');
      expect(result).not.toBe('DEVICE_NOT_IN_SESSION_ROOM');
      expect(result).not.toBe('JOIN_CODE_SCOPES_EMPTY');
      if (
        typeof result === 'string' ||
        result === undefined ||
        result === null
      ) {
        throw new Error('expected codes object');
      }
      expect(result.current.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(result.current.validStart).toEqual(NOW);
      expect(result.next).toBeNull();
      expect(mockRepo.insertJoinCode).toHaveBeenCalledTimes(1);
    });

    it('returns the existing current code without rotating when far from expiry', async () => {
      // Arrange
      const existing = {
        joinCode: 'ABC12345',
        sessionUid: SESSION_UID,
        validStart: new Date(NOW.getTime() - 60_000),
        validEnd: new Date(NOW.getTime() + 5 * 60_000),
      };
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.findActiveJoinCodes.mockResolvedValue([existing]);

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected codes object');
      expect(result.current).toStrictEqual(existing);
      expect(result.next).toBeNull();
      expect(mockRepo.insertJoinCode).not.toHaveBeenCalled();
    });

    it('precomputes the next code when the current is inside the handoff window', async () => {
      // Arrange - current expires in 30s, well within the 60s handoff window.
      const expiringCurrent = {
        joinCode: 'ABC12345',
        sessionUid: SESSION_UID,
        validStart: new Date(NOW.getTime() - 4 * 60_000),
        validEnd: new Date(NOW.getTime() + 30_000),
      };
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.findActiveJoinCodes.mockResolvedValue([expiringCurrent]);
      mockRepo.insertJoinCode.mockImplementation((_db, data) =>
        Promise.resolve(data),
      );

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected codes object');
      expect(result.current).toStrictEqual(expiringCurrent);
      expect(result.next).not.toBeNull();
      expect(result.next!.validStart).toEqual(expiringCurrent.validEnd);
      expect(mockRepo.insertJoinCode).toHaveBeenCalledTimes(1);
    });

    it('returns the existing pair without inserting when both are already present', async () => {
      // Arrange - both codes exist; return them as-is (idempotent).
      const current = {
        joinCode: 'CURR1234',
        sessionUid: SESSION_UID,
        validStart: new Date(NOW.getTime() - 4 * 60_000),
        validEnd: new Date(NOW.getTime() + 30_000),
      };
      const next = {
        joinCode: 'NEXT1234',
        sessionUid: SESSION_UID,
        validStart: current.validEnd,
        validEnd: new Date(current.validEnd.getTime() + 5 * 60_000),
      };
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.findActiveJoinCodes.mockResolvedValue([current, next]);

      // Act
      const result = await service.fetchJoinCodes(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected codes object');
      expect(result.current).toStrictEqual(current);
      expect(result.next).toStrictEqual(next);
      expect(mockRepo.insertJoinCode).not.toHaveBeenCalled();
    });
  });

  describe('exchangeDeviceToken', (it) => {
    it("returns 'SESSION_NOT_FOUND' when the session does not exist", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(undefined);

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      expect(result).toBe('SESSION_NOT_FOUND');
    });

    it("returns 'DEVICE_NOT_IN_SESSION_ROOM' when the device is not in the room", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(false);

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      expect(result).toBe('DEVICE_NOT_IN_SESSION_ROOM');
    });

    it("returns 'SESSION_NOT_CURRENTLY_ACTIVE' when the session has not started", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(NOT_YET_STARTED_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      expect(result).toBe('SESSION_NOT_CURRENTLY_ACTIVE');
    });

    it("returns 'SESSION_NOT_CURRENTLY_ACTIVE' when the session has ended", async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ENDED_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      expect(result).toBe('SESSION_NOT_CURRENTLY_ACTIVE');
    });

    it('grants SEND_AUDIO + RECEIVE_TRANSCRIPTIONS to a source device', async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.isDeviceSourceForRoom.mockResolvedValue(true);
      mockTokenService.sign.mockReturnValue('signed-token');

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      if (typeof result === 'string') throw new Error('expected token result');
      expect(result.scopes).toStrictEqual([
        'SEND_AUDIO',
        'RECEIVE_TRANSCRIPTIONS',
      ]);
      expect(result.sessionToken).toBe('signed-token');
      expect(mockTokenService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUid: SESSION_UID,
          clientId: DEVICE_UID,
          scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        }),
      );
    });

    it('grants RECEIVE_TRANSCRIPTIONS only to a non-source device', async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.isDeviceSourceForRoom.mockResolvedValue(false);
      mockTokenService.sign.mockReturnValue('signed-token');

      // Act
      const result = await service.exchangeDeviceToken(
        DEVICE_UID,
        SESSION_UID,
        NOW,
      );

      // Assert
      if (typeof result === 'string') throw new Error('expected token result');
      expect(result.scopes).toStrictEqual(['RECEIVE_TRANSCRIPTIONS']);
    });

    it('does not issue a refresh token', async () => {
      // Arrange
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockRepo.isDeviceInRoom.mockResolvedValue(true);
      mockRepo.isDeviceSourceForRoom.mockResolvedValue(false);
      mockTokenService.sign.mockReturnValue('signed-token');

      // Act
      await service.exchangeDeviceToken(DEVICE_UID, SESSION_UID, NOW);

      // Assert
      expect(mockRepo.insertRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('exchangeJoinCode', (it) => {
    const VALID_CODE = {
      joinCode: 'ABC12345',
      sessionUid: SESSION_UID,
      validStart: new Date(NOW.getTime() - 60_000),
      validEnd: new Date(NOW.getTime() + 60_000),
    };

    it("returns 'JOIN_CODE_NOT_FOUND' when the code does not exist", async () => {
      // Arrange
      mockRepo.findJoinCodeByCode.mockResolvedValue(undefined);

      // Act
      const result = await service.exchangeJoinCode('NOPE0000', NOW);

      // Assert
      expect(result).toBe('JOIN_CODE_NOT_FOUND');
    });

    it("returns 'JOIN_CODE_EXPIRED' when the code has expired", async () => {
      // Arrange
      mockRepo.findJoinCodeByCode.mockResolvedValue({
        ...VALID_CODE,
        validEnd: new Date(NOW.getTime() - 1),
      });

      // Act
      const result = await service.exchangeJoinCode(VALID_CODE.joinCode, NOW);

      // Assert
      expect(result).toBe('JOIN_CODE_EXPIRED');
    });

    it("returns 'SESSION_NOT_CURRENTLY_ACTIVE' when the session has ended", async () => {
      // Arrange
      mockRepo.findJoinCodeByCode.mockResolvedValue(VALID_CODE);
      mockRepo.findSessionForAuth.mockResolvedValue(ENDED_SESSION);

      // Act
      const result = await service.exchangeJoinCode(VALID_CODE.joinCode, NOW);

      // Assert
      expect(result).toBe('SESSION_NOT_CURRENTLY_ACTIVE');
    });

    it("returns 'SESSION_NOT_CURRENTLY_ACTIVE' when the session row is missing", async () => {
      // Arrange - row was deleted between the join-code lookup and the session lookup.
      mockRepo.findJoinCodeByCode.mockResolvedValue(VALID_CODE);
      mockRepo.findSessionForAuth.mockResolvedValue(undefined);

      // Act
      const result = await service.exchangeJoinCode(VALID_CODE.joinCode, NOW);

      // Assert
      expect(result).toBe('SESSION_NOT_CURRENTLY_ACTIVE');
    });

    it('issues a session token, refresh token, and a fresh clientId', async () => {
      // Arrange
      mockRepo.findJoinCodeByCode.mockResolvedValue(VALID_CODE);
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockHashService.hash.mockResolvedValue('hash');
      mockRepo.insertRefreshToken.mockResolvedValue({ uid: 'refresh-uid' });
      mockTokenService.sign.mockReturnValue('signed-token');

      // Act
      const result = await service.exchangeJoinCode(VALID_CODE.joinCode, NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected token result');
      expect(result.sessionUid).toBe(SESSION_UID);
      expect(result.scopes).toStrictEqual(ACTIVE_SESSION.joinCodeScopes);
      expect(result.sessionToken).toBe('signed-token');
      // Refresh token format is `{uid}:{secret}`.
      expect(result.sessionRefreshToken).toMatch(/^refresh-uid:.+/);
      // ClientId is a freshly minted UUID.
      expect(result.clientId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(mockRepo.insertRefreshToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sessionUid: SESSION_UID,
          authMethod: 'JOIN_CODE',
          scopes: ACTIVE_SESSION.joinCodeScopes,
        }),
      );
    });

    it('hashes the refresh secret before persisting it', async () => {
      // Arrange
      mockRepo.findJoinCodeByCode.mockResolvedValue(VALID_CODE);
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockHashService.hash.mockResolvedValue('hashed-secret');
      mockRepo.insertRefreshToken.mockResolvedValue({ uid: 'refresh-uid' });
      mockTokenService.sign.mockReturnValue('signed-token');

      // Act
      const result = await service.exchangeJoinCode(VALID_CODE.joinCode, NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected token result');
      const presentedSecret = result.sessionRefreshToken.slice(
        result.sessionRefreshToken.indexOf(':') + 1,
      );
      // The plaintext secret is what was passed to hash(); the DB only sees
      // the hash returned from the hash service.
      expect(mockHashService.hash).toHaveBeenCalledWith(presentedSecret);
      expect(mockRepo.insertRefreshToken).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ hash: 'hashed-secret' }),
      );
    });
  });

  describe('refreshSessionToken', (it) => {
    it("returns 'INVALID_REFRESH_TOKEN' when the token has no separator", async () => {
      // Arrange / Act
      const result = await service.refreshSessionToken('no-separator', NOW);

      // Assert
      expect(result).toBe('INVALID_REFRESH_TOKEN');
    });

    it("returns 'INVALID_REFRESH_TOKEN' when the token row is missing", async () => {
      // Arrange
      mockRepo.findRefreshTokenByUid.mockResolvedValue(undefined);

      // Act
      const result = await service.refreshSessionToken('uid:secret', NOW);

      // Assert
      expect(result).toBe('INVALID_REFRESH_TOKEN');
    });

    it("returns 'INVALID_REFRESH_TOKEN' when the secret does not match", async () => {
      // Arrange
      mockRepo.findRefreshTokenByUid.mockResolvedValue({
        uid: 'uid',
        sessionUid: SESSION_UID,
        clientId: 'client-1',
        hash: 'stored-hash',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
        authMethod: 'JOIN_CODE',
      });
      mockHashService.verify.mockResolvedValue(false);

      // Act
      const result = await service.refreshSessionToken('uid:wrong', NOW);

      // Assert
      expect(result).toBe('INVALID_REFRESH_TOKEN');
    });

    it("returns 'SESSION_ENDED' when the session is no longer active", async () => {
      // Arrange
      mockRepo.findRefreshTokenByUid.mockResolvedValue({
        uid: 'uid',
        sessionUid: SESSION_UID,
        clientId: 'client-1',
        hash: 'stored-hash',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
        authMethod: 'JOIN_CODE',
      });
      mockHashService.verify.mockResolvedValue(true);
      mockRepo.findSessionForAuth.mockResolvedValue(ENDED_SESSION);

      // Act
      const result = await service.refreshSessionToken('uid:secret', NOW);

      // Assert
      expect(result).toBe('SESSION_ENDED');
    });

    it('returns a new session token preserving the original scopes and clientId', async () => {
      // Arrange
      mockRepo.findRefreshTokenByUid.mockResolvedValue({
        uid: 'uid',
        sessionUid: SESSION_UID,
        clientId: 'client-1',
        hash: 'stored-hash',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
        authMethod: 'JOIN_CODE',
      });
      mockHashService.verify.mockResolvedValue(true);
      mockRepo.findSessionForAuth.mockResolvedValue(ACTIVE_SESSION);
      mockTokenService.sign.mockReturnValue('refreshed-token');

      // Act
      const result = await service.refreshSessionToken('uid:secret', NOW);

      // Assert
      if (typeof result === 'string') throw new Error('expected token result');
      expect(result.sessionToken).toBe('refreshed-token');
      expect(mockTokenService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUid: SESSION_UID,
          clientId: 'client-1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
        }),
      );
    });
  });
});
