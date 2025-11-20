import { beforeEach, describe, expect, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type { BaseLogger } from '@scribear/base-fastify-server';

import { SessionService } from '../../../../../src/server/features/session/session.service.js';

describe('SessionService', () => {
  let mockLogger: MockProxy<BaseLogger>;
  let sessionService: SessionService;

  beforeEach(() => {
    mockLogger = mock<BaseLogger>();
    sessionService = new SessionService(mockLogger);
    vi.clearAllTimers();
  });

  describe('createSession', (it) => {
    /**
     * Test that createSession creates a session with all required fields
     */
    it('creates session with all fields', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        maxClients: 10,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session = await sessionService.createSession(params);

      // Assert
      expect(session).toBeDefined();
      expect(session.sessionId).toMatch(/^session_[0-9a-f]{32}$/);
      expect(session.sessionLength).toBe(3600);
      expect(session.maxClients).toBe(10);
      expect(session.enableJoinCode).toBe(true);
      expect(session.joinCode).toBeDefined();
      expect(session.joinCode).toHaveLength(8);
      expect(session.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(session.audioSourceSecretHash).toBeDefined();
      expect(session.audioSourceSecretHash).not.toBe('test-secret-123456');
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.expiresAt).toBeInstanceOf(Date);
      expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(
        3600000,
      );
    });

    /**
     * Test that createSession uses default values for optional fields
     */
    it('creates session with default values', async () => {
      // Arrange
      const params = {
        sessionLength: 7200,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session = await sessionService.createSession(params);

      // Assert
      expect(session.maxClients).toBe(0);
      expect(session.enableJoinCode).toBe(false);
      expect(session.joinCode).toBeUndefined();
    });

    /**
     * Test that createSession does not create join code when disabled
     */
    it('creates session without join code when disabled', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        enableJoinCode: false,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session = await sessionService.createSession(params);

      // Assert
      expect(session.enableJoinCode).toBe(false);
      expect(session.joinCode).toBeUndefined();
    });

    /**
     * Test that createSession hashes the audio source secret
     */
    it('hashes audio source secret', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        audioSourceSecret: 'my-secret-password',
      };

      // Act
      const session = await sessionService.createSession(params);

      // Assert
      expect(session.audioSourceSecretHash).toBeDefined();
      expect(session.audioSourceSecretHash).not.toBe('my-secret-password');
      expect(session.audioSourceSecretHash.startsWith('$2b$')).toBe(true); // bcrypt hash format
    });

    /**
     * Test that createSession logs session creation
     */
    it('logs session creation', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session = await sessionService.createSession(params);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          sessionId: session.sessionId,
          joinCode: session.joinCode,
          expiresAt: session.expiresAt,
        },
        'Session created successfully',
      );
    });

    /**
     * Test that createSession generates unique session IDs
     */
    it('generates unique session IDs', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session1 = await sessionService.createSession(params);
      const session2 = await sessionService.createSession(params);

      // Assert
      expect(session1.sessionId).not.toBe(session2.sessionId);
    });

    /**
     * Test that createSession generates unique join codes
     */
    it('generates unique join codes', async () => {
      // Arrange
      const params = {
        sessionLength: 3600,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      };

      // Act
      const session1 = await sessionService.createSession(params);
      const session2 = await sessionService.createSession(params);

      // Assert
      expect(session1.joinCode).toBeDefined();
      expect(session2.joinCode).toBeDefined();
      expect(session1.joinCode).not.toBe(session2.joinCode);
    });
  });

  describe('getSession', (it) => {
    /**
     * Test that getSession returns existing session
     */
    it('returns existing session', async () => {
      // Arrange
      const createdSession = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      const retrievedSession = sessionService.getSession(
        createdSession.sessionId,
      );

      // Assert
      expect(retrievedSession).toBeDefined();
      expect(retrievedSession?.sessionId).toBe(createdSession.sessionId);
    });

    /**
     * Test that getSession returns undefined for non-existent session
     */
    it('returns undefined for non-existent session', () => {
      // Act
      const session = sessionService.getSession('session_nonexistent');

      // Assert
      expect(session).toBeUndefined();
    });

    /**
     * Test that getSession returns undefined for expired session
     */
    it('returns undefined for expired session', async () => {
      // Arrange
      vi.useFakeTimers();
      const createdSession = await sessionService.createSession({
        sessionLength: 1, // 1 second
        audioSourceSecret: 'test-secret-123456',
      });

      // Act - advance time past expiration
      vi.advanceTimersByTime(2000);
      const retrievedSession = sessionService.getSession(
        createdSession.sessionId,
      );

      // Assert
      expect(retrievedSession).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('getSessionByJoinCode', (it) => {
    /**
     * Test that getSessionByJoinCode returns session with valid join code
     */
    it('returns session with valid join code', async () => {
      // Arrange
      const createdSession = await sessionService.createSession({
        sessionLength: 3600,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      const retrievedSession = sessionService.getSessionByJoinCode(
        createdSession.joinCode!,
      );

      // Assert
      expect(retrievedSession).toBeDefined();
      expect(retrievedSession?.sessionId).toBe(createdSession.sessionId);
      expect(retrievedSession?.joinCode).toBe(createdSession.joinCode);
    });

    /**
     * Test that getSessionByJoinCode returns undefined for invalid join code
     */
    it('returns undefined for invalid join code', () => {
      // Act
      const session = sessionService.getSessionByJoinCode('INVALID1');

      // Assert
      expect(session).toBeUndefined();
    });

    /**
     * Test that getSessionByJoinCode returns undefined for expired session
     */
    it('returns undefined for expired session via join code', async () => {
      // Arrange
      vi.useFakeTimers();
      const createdSession = await sessionService.createSession({
        sessionLength: 1,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      vi.advanceTimersByTime(2000);
      const retrievedSession = sessionService.getSessionByJoinCode(
        createdSession.joinCode!,
      );

      // Assert
      expect(retrievedSession).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('verifyAudioSourceSecret', (it) => {
    /**
     * Test that verifyAudioSourceSecret returns true for correct secret
     */
    it('returns true for correct secret', async () => {
      // Arrange
      const secret = 'correct-secret-123';
      const session = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: secret,
      });

      // Act
      const isValid = await sessionService.verifyAudioSourceSecret(
        session.sessionId,
        secret,
      );

      // Assert
      expect(isValid).toBe(true);
    });

    /**
     * Test that verifyAudioSourceSecret returns false for incorrect secret
     */
    it('returns false for incorrect secret', async () => {
      // Arrange
      const session = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'correct-secret-123',
      });

      // Act
      const isValid = await sessionService.verifyAudioSourceSecret(
        session.sessionId,
        'wrong-secret-456',
      );

      // Assert
      expect(isValid).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { sessionId: session.sessionId },
        'Invalid audio source secret',
      );
    });

    /**
     * Test that verifyAudioSourceSecret returns false for non-existent session
     */
    it('returns false for non-existent session', async () => {
      // Act
      const isValid = await sessionService.verifyAudioSourceSecret(
        'session_nonexistent',
        'any-secret',
      );

      // Assert
      expect(isValid).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { sessionId: 'session_nonexistent' },
        'Session not found for secret verification',
      );
    });
  });

  describe('isSessionValid', (it) => {
    /**
     * Test that isSessionValid returns true for valid session
     */
    it('returns true for valid session', async () => {
      // Arrange
      const session = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      const isValid = sessionService.isSessionValid(session.sessionId);

      // Assert
      expect(isValid).toBe(true);
    });

    /**
     * Test that isSessionValid returns false for non-existent session
     */
    it('returns false for non-existent session', () => {
      // Act
      const isValid = sessionService.isSessionValid('session_nonexistent');

      // Assert
      expect(isValid).toBe(false);
    });

    /**
     * Test that isSessionValid returns false for expired session
     */
    it('returns false for expired session', async () => {
      // Arrange
      vi.useFakeTimers();
      const session = await sessionService.createSession({
        sessionLength: 1,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      vi.advanceTimersByTime(2000);
      const isValid = sessionService.isSessionValid(session.sessionId);

      // Assert
      expect(isValid).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('getActiveSessions', (it) => {
    /**
     * Test that getActiveSessions returns all active sessions
     */
    it('returns all active sessions', async () => {
      // Arrange
      const session1 = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'secret-1',
      });
      const session2 = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'secret-2',
      });

      // Act
      const activeSessions = sessionService.getActiveSessions();

      // Assert
      expect(activeSessions).toHaveLength(2);
      expect(activeSessions.map((s) => s.sessionId)).toContain(
        session1.sessionId,
      );
      expect(activeSessions.map((s) => s.sessionId)).toContain(
        session2.sessionId,
      );
    });

    /**
     * Test that getActiveSessions filters out expired sessions
     */
    it('filters out expired sessions', async () => {
      // Arrange
      vi.useFakeTimers();
      await sessionService.createSession({
        sessionLength: 1,
        audioSourceSecret: 'secret-1',
      });
      const session2 = await sessionService.createSession({
        sessionLength: 3600,
        audioSourceSecret: 'secret-2',
      });

      // Act
      vi.advanceTimersByTime(2000);
      const activeSessions = sessionService.getActiveSessions();

      // Assert
      expect(activeSessions).toHaveLength(1);
      const firstSession = activeSessions[0];
      if (!firstSession) {
        throw new Error('Expected one active session');
      }
      expect(firstSession.sessionId).toBe(session2.sessionId);

      vi.useRealTimers();
    });

    /**
     * Test that getActiveSessions returns empty array when no sessions exist
     */
    it('returns empty array when no sessions exist', () => {
      // Act
      const activeSessions = sessionService.getActiveSessions();

      // Assert
      expect(activeSessions).toHaveLength(0);
    });
  });

  describe('session cleanup', (it) => {
    /**
     * Test that expired sessions are automatically cleaned up
     */
    it('cleans up expired sessions', async () => {
      // Arrange
      vi.useFakeTimers();
      const session = await sessionService.createSession({
        sessionLength: 1,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act - advance time past expiration
      vi.advanceTimersByTime(2000);
      const retrievedSession = sessionService.getSession(session.sessionId);

      // Assert
      expect(retrievedSession).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { sessionId: session.sessionId },
        'Session cleaned up',
      );

      vi.useRealTimers();
    });

    /**
     * Test that join code mapping is cleaned up with session
     */
    it('cleans up join code mapping when session expires', async () => {
      // Arrange
      vi.useFakeTimers();
      const session = await sessionService.createSession({
        sessionLength: 1,
        enableJoinCode: true,
        audioSourceSecret: 'test-secret-123456',
      });

      // Act
      vi.advanceTimersByTime(2000);
      const retrievedByJoinCode = sessionService.getSessionByJoinCode(
        session.joinCode!,
      );

      // Assert
      expect(retrievedByJoinCode).toBeUndefined();

      vi.useRealTimers();
    });
  });
});
