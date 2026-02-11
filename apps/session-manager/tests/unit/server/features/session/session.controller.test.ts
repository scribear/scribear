import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import type {
  CREATE_SESSION_SCHEMA,
  CREATE_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import SessionController from '#src/server/features/session/session.controller.js';
import type {
  Session,
  SessionService,
} from '#src/server/features/session/session.service.js';
import type { JwtService } from '#src/server/services/jwt.service.js';

describe('Session controller', () => {
  const testRequestId = 'TEST_REQUEST_ID';
  let mockReply: {
    code: Mock;
    send: Mock;
  };
  let mockSessionService: MockProxy<SessionService>;
  let mockJwtService: MockProxy<JwtService>;
  let sessionController: SessionController;

  beforeEach(() => {
    mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    mockSessionService = mock<SessionService>();
    mockJwtService = mock<JwtService>();
    sessionController = new SessionController(
      mockSessionService,
      mockJwtService,
    );
  });

  describe('createSession handler', (it) => {
    /**
     * Test that createSession correctly calls sessionService and replies with result
     */
    it('creates session without join code', async () => {
      // Arrange
      const mockSession: Session = {
        sessionId: 'session_abc123',
        sessionLength: 3600,
        maxClients: 10,
        enableJoinCode: false,
        audioSourceSecretHash: 'hashed_secret',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        expiresAt: new Date('2025-01-01T01:00:00Z'),
      };

      mockSessionService.createSession.mockResolvedValue(mockSession);

      const mockReq = {
        id: testRequestId,
        body: {
          sessionLength: 3600,
          maxClients: 10,
          enableJoinCode: false,
          audioSourceSecret: 'test-secret-123456',
        },
      };

      // Act
      await sessionController.createSession(
        mockReq as unknown as BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
        mockReply as unknown as BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
      );

      // Assert
      expect(mockSessionService.createSession).toHaveBeenCalledExactlyOnceWith({
        sessionLength: 3600,
        maxClients: 10,
        enableJoinCode: false,
        audioSourceSecret: 'test-secret-123456',
      });
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session_abc123',
        expiresAt: '2025-01-01T01:00:00.000Z',
      });
    });

    /**
     * Test that createSession includes join code in response when enabled
     */
    it('creates session with join code', async () => {
      // Arrange
      const mockSession: Session = {
        sessionId: 'session_xyz789',
        sessionLength: 7200,
        maxClients: 0,
        enableJoinCode: true,
        joinCode: 'ABCD1234',
        audioSourceSecretHash: 'hashed_secret',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        expiresAt: new Date('2025-01-01T02:00:00Z'),
      };

      mockSessionService.createSession.mockResolvedValue(mockSession);

      const mockReq = {
        id: testRequestId,
        body: {
          sessionLength: 7200,
          enableJoinCode: true,
          audioSourceSecret: 'test-secret-123456',
        },
      };

      // Act
      await sessionController.createSession(
        mockReq as unknown as BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
        mockReply as unknown as BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
      );

      // Assert
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'session_xyz789',
        joinCode: 'ABCD1234',
        expiresAt: '2025-01-01T02:00:00.000Z',
      });
    });

    /**
     * Test that createSession passes only defined optional parameters
     */
    it('omits undefined optional parameters when creating session', async () => {
      // Arrange
      const mockSession: Session = {
        sessionId: 'session_test',
        sessionLength: 3600,
        maxClients: 0,
        enableJoinCode: false,
        audioSourceSecretHash: 'hashed_secret',
        createdAt: new Date(),
        expiresAt: new Date(),
      };

      mockSessionService.createSession.mockResolvedValue(mockSession);

      const mockReq = {
        id: testRequestId,
        body: {
          sessionLength: 3600,
          audioSourceSecret: 'test-secret-123456',
        },
      };

      // Act
      await sessionController.createSession(
        mockReq as unknown as BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
        mockReply as unknown as BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
      );

      // Assert
      expect(mockSessionService.createSession).toHaveBeenCalledExactlyOnceWith({
        sessionLength: 3600,
        audioSourceSecret: 'test-secret-123456',
      });
    });
  });

  describe('createToken handler', () => {
    describe('via sessionId and audioSourceSecret', () => {
      /**
       * Test that createToken successfully creates token with valid credentials
       */
      it('creates token with valid sessionId and audioSourceSecret', async () => {
        // Arrange
        mockSessionService.verifyAudioSourceSecret.mockResolvedValue(true);
        mockSessionService.isSessionValid.mockReturnValue(true);
        mockJwtService.issueToken.mockReturnValue('jwt.token.here');

        const mockReq = {
          id: testRequestId,
          body: {
            sessionId: 'session_valid',
            audioSourceSecret: 'correct-secret',
            scope: 'source' as const,
          },
        };

        // Act
        await sessionController.createToken(
          mockReq as unknown as BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
          mockReply as unknown as BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
        );

        // Assert
        expect(
          mockSessionService.verifyAudioSourceSecret,
        ).toHaveBeenCalledExactlyOnceWith('session_valid', 'correct-secret');
        expect(
          mockSessionService.isSessionValid,
        ).toHaveBeenCalledExactlyOnceWith('session_valid');
        expect(mockJwtService.issueToken).toHaveBeenCalledExactlyOnceWith(
          'session_valid',
          'source',
          'audio-source',
        );
        expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
        expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
          token: 'jwt.token.here',
          expiresIn: '24h',
          sessionId: 'session_valid',
          scope: 'source',
        });
      });

      /**
       * Test that createToken rejects invalid audioSourceSecret
       */
      it('throws Unauthorized error with invalid audioSourceSecret', async () => {
        // Arrange
        mockSessionService.verifyAudioSourceSecret.mockResolvedValue(false);

        const mockReq = {
          id: testRequestId,
          body: {
            sessionId: 'session_valid',
            audioSourceSecret: 'wrong-secret',
            scope: 'source' as const,
          },
        };

        // Act & Assert
        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow(HttpError.Unauthorized);

        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow('Invalid session ID or audio source secret');
      });

      /**
       * Test that createToken rejects expired session
       */
      it('throws NotFound error when session is expired', async () => {
        // Arrange
        mockSessionService.verifyAudioSourceSecret.mockResolvedValue(true);
        mockSessionService.isSessionValid.mockReturnValue(false);

        const mockReq = {
          id: testRequestId,
          body: {
            sessionId: 'session_expired',
            audioSourceSecret: 'correct-secret',
            scope: 'source' as const,
          },
        };

        // Act & Assert
        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow(HttpError.NotFound);

        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow('Session expired or not found');
      });
    });

    describe('via joinCode', (it) => {
      /**
       * Test that createToken successfully creates token with valid join code
       */
      it('creates token with valid joinCode', async () => {
        // Arrange
        const mockSession: Session = {
          sessionId: 'session_join',
          sessionLength: 3600,
          maxClients: 0,
          enableJoinCode: true,
          joinCode: 'VALID123',
          audioSourceSecretHash: 'hashed_secret',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        };

        mockSessionService.getSessionByJoinCode.mockReturnValue(mockSession);
        mockSessionService.isSessionValid.mockReturnValue(true);
        mockJwtService.issueToken.mockReturnValue('jwt.token.here');

        const mockReq = {
          id: testRequestId,
          body: {
            joinCode: 'VALID123',
            scope: 'sink' as const,
          },
        };

        // Act
        await sessionController.createToken(
          mockReq as unknown as BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
          mockReply as unknown as BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
        );

        // Assert
        expect(
          mockSessionService.getSessionByJoinCode,
        ).toHaveBeenCalledExactlyOnceWith('VALID123');
        expect(mockJwtService.issueToken).toHaveBeenCalledExactlyOnceWith(
          'session_join',
          'sink',
          undefined,
        );
        expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
          token: 'jwt.token.here',
          expiresIn: '24h',
          sessionId: 'session_join',
          scope: 'sink',
        });
      });

      /**
       * Test that createToken rejects invalid join code
       */
      it('throws NotFound error with invalid joinCode', async () => {
        // Arrange
        mockSessionService.getSessionByJoinCode.mockReturnValue(undefined);

        const mockReq = {
          id: testRequestId,
          body: {
            joinCode: 'INVALID1',
            scope: 'sink' as const,
          },
        };

        // Act & Assert
        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow(HttpError.NotFound);

        await expect(
          sessionController.createToken(
            mockReq as unknown as BaseFastifyRequest<
              typeof CREATE_TOKEN_SCHEMA
            >,
            mockReply as unknown as BaseFastifyReply<
              typeof CREATE_TOKEN_SCHEMA
            >,
          ),
        ).rejects.toThrow('Invalid join code');
      });
    });

    describe('scope handling', (it) => {
      /**
       * Test that createToken correctly handles all scope types
       */
      it('creates token with sink scope', async () => {
        // Arrange
        mockSessionService.verifyAudioSourceSecret.mockResolvedValue(true);
        mockSessionService.isSessionValid.mockReturnValue(true);
        mockJwtService.issueToken.mockReturnValue('jwt.token.here');

        const mockReq = {
          id: testRequestId,
          body: {
            sessionId: 'session_valid',
            audioSourceSecret: 'correct-secret',
            scope: 'sink' as const,
          },
        };

        // Act
        await sessionController.createToken(
          mockReq as unknown as BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
          mockReply as unknown as BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
        );

        // Assert
        expect(mockJwtService.issueToken).toHaveBeenCalledWith(
          'session_valid',
          'sink',
          'audio-source',
        );
      });

      it('creates token with both scope', async () => {
        // Arrange
        mockSessionService.verifyAudioSourceSecret.mockResolvedValue(true);
        mockSessionService.isSessionValid.mockReturnValue(true);
        mockJwtService.issueToken.mockReturnValue('jwt.token.here');

        const mockReq = {
          id: testRequestId,
          body: {
            sessionId: 'session_valid',
            audioSourceSecret: 'correct-secret',
            scope: 'both' as const,
          },
        };

        // Act
        await sessionController.createToken(
          mockReq as unknown as BaseFastifyRequest<typeof CREATE_TOKEN_SCHEMA>,
          mockReply as unknown as BaseFastifyReply<typeof CREATE_TOKEN_SCHEMA>,
        );

        // Assert
        expect(mockJwtService.issueToken).toHaveBeenCalledWith(
          'session_valid',
          'both',
          'audio-source',
        );
      });
    });
  });
});
