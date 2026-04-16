import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import {
  AudioSourceServerMessageType,
  SessionClientServerMessageType,
  SessionTokenScope,
} from '@scribear/node-server-schema';

import { SessionStreamingController } from '#src/server/features/session-streaming/session-streaming.controller.js';

const TEST_SESSION_ID = 'test-session-id';
const TEST_SESSION_TOKEN = 'valid.jwt.token';

describe('SessionStreamingController', () => {
  let mockService: {
    on: Mock;
    startAuthTimeout: Mock;
    handleClientAuth: Mock;
    handleAudioChunk: Mock;
    handleClose: Mock;
  };
  let mockSocket: {
    on: Mock;
    send: Mock;
    close: Mock;
  };
  let mockReq: { params: { sessionId: string } };
  let mockJwtService: { verifySessionToken: ReturnType<typeof vi.fn> };
  let mockTranscriptionServiceManager: { setMuted: ReturnType<typeof vi.fn> };
  let controller: SessionStreamingController;

  // Captures the callback registered via socket.on(eventName, callback)
  function captureSocketHandler(event: string): (...args: unknown[]) => void {
    const call = mockSocket.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    return call![1];
  }

  // Captures the callback registered via service.on(eventName, callback)
  function captureServiceHandler(event: string): (...args: unknown[]) => void {
    const call = mockService.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    return call![1];
  }

  beforeEach(() => {
    mockService = {
      on: vi.fn(),
      startAuthTimeout: vi.fn(),
      handleClientAuth: vi.fn(),
      handleAudioChunk: vi.fn(),
      handleClose: vi.fn(),
    };
    mockSocket = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    mockReq = {
      params: { sessionId: TEST_SESSION_ID },
    };
    mockJwtService = { verifySessionToken: vi.fn() };
    mockTranscriptionServiceManager = { setMuted: vi.fn() };

    controller = new SessionStreamingController(
      mockService as never,
      mockJwtService as never,
      mockTranscriptionServiceManager as never,
    );
  });

  describe('audioSource', (it) => {
    it('starts auth timeout on connection', () => {
      // Act
      controller.audioSource(mockSocket as never, mockReq as never);

      // Assert
      expect(mockService.startAuthTimeout).toHaveBeenCalledOnce();
    });

    it('forwards service close event to socket', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const closeHandler = captureServiceHandler('close');

      // Act
      closeHandler(1008, 'Auth timeout');

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Auth timeout',
      );
    });

    it('forwards service send event to socket', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const sendHandler = captureServiceHandler('send');

      // Act
      sendHandler('{"type":"IP_TRANSCRIPT"}');

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        '{"type":"IP_TRANSCRIPT"}',
      );
    });

    it('handles binary messages as audio chunks', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');
      const chunk = Buffer.from('audio-data');

      // Act
      messageHandler(chunk, true);

      // Assert
      expect(mockService.handleAudioChunk).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        chunk,
      );
    });

    it('handles AUTH message', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');
      const msg = JSON.stringify({
        type: 'AUTH',
        sessionToken: TEST_SESSION_TOKEN,
      });

      // Act
      messageHandler(Buffer.from(msg), false);

      // Assert
      expect(mockService.handleClientAuth).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        TEST_SESSION_TOKEN,
        { sendAudio: true },
      );
    });

    it('maps transcript events to AudioSource message type', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const handler = captureServiceHandler('transcript');

      // Act
      handler({
        final: { text: ['done'], starts: null, ends: null },
        inProgress: { text: ['hello'], starts: [0], ends: [100] },
      });

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: AudioSourceServerMessageType.TRANSCRIPT,
          final: { text: ['done'], starts: null, ends: null },
          in_progress: { text: ['hello'], starts: [0], ends: [100] },
        }),
      );
    });

    it('maps session-status events to AudioSource message type', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const handler = captureServiceHandler('session-status');

      // Act
      handler({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      });

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: AudioSourceServerMessageType.SESSION_STATUS,
          transcriptionServiceConnected: true,
          sourceDeviceConnected: false,
        }),
      );
    });

    it('closes socket with 1007 for invalid JSON', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');

      // Act
      messageHandler(Buffer.from('not json'), false);

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1007,
        'Invalid JSON',
      );
    });

    it('closes socket with 1007 for invalid message format', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');
      const msg = JSON.stringify({ type: 'UNKNOWN' });

      // Act
      messageHandler(Buffer.from(msg), false);

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1007,
        'Invalid message format',
      );
    });

    it('calls handleClose on socket close', () => {
      // Arrange
      controller.audioSource(mockSocket as never, mockReq as never);
      const closeHandler = captureSocketHandler('close');

      // Act
      closeHandler();

      // Assert
      expect(mockService.handleClose).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });
  });

  describe('sessionClient', (it) => {
    it('starts auth timeout on connection', () => {
      // Act
      controller.sessionClient(mockSocket as never, mockReq as never);

      // Assert
      expect(mockService.startAuthTimeout).toHaveBeenCalledOnce();
    });

    it('forwards service close event to socket', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const closeHandler = captureServiceHandler('close');

      // Act
      closeHandler(1008, 'Auth timeout');

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Auth timeout',
      );
    });

    it('forwards service send event to socket', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const sendHandler = captureServiceHandler('send');

      // Act
      sendHandler('{"type":"IP_TRANSCRIPT"}');

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        '{"type":"IP_TRANSCRIPT"}',
      );
    });

    it('closes socket with 1007 for binary messages', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');

      // Act
      messageHandler(Buffer.from('binary'), true);

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1007,
        'Binary messages not allowed',
      );
    });

    it('handles AUTH message with receiveTranscriptions required', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');
      const msg = JSON.stringify({
        type: 'AUTH',
        sessionToken: TEST_SESSION_TOKEN,
      });

      // Act
      messageHandler(Buffer.from(msg), false);

      // Assert
      expect(mockService.handleClientAuth).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        TEST_SESSION_TOKEN,
        { receiveTranscriptions: true },
      );
    });

    it('maps transcript events to SessionClient message type', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const handler = captureServiceHandler('transcript');

      // Act
      handler({
        final: { text: ['done'], starts: null, ends: null },
        inProgress: { text: ['hello'], starts: [0], ends: [100] },
      });

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: SessionClientServerMessageType.TRANSCRIPT,
          final: { text: ['done'], starts: null, ends: null },
          in_progress: { text: ['hello'], starts: [0], ends: [100] },
        }),
      );
    });

    it('maps session-status events to SessionClient message type', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const handler = captureServiceHandler('session-status');

      // Act
      handler({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });

      // Assert
      expect(mockSocket.send).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: SessionClientServerMessageType.SESSION_STATUS,
          transcriptionServiceConnected: true,
          sourceDeviceConnected: true,
        }),
      );
    });

    it('closes socket with 1007 for invalid JSON', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');

      // Act
      messageHandler(Buffer.from('not json'), false);

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1007,
        'Invalid JSON',
      );
    });

    it('closes socket with 1007 for invalid message format', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const messageHandler = captureSocketHandler('message');
      const msg = JSON.stringify({ type: 'UNKNOWN' });

      // Act
      messageHandler(Buffer.from(msg), false);

      // Assert
      expect(mockSocket.close).toHaveBeenCalledExactlyOnceWith(
        1007,
        'Invalid message format',
      );
    });

    it('calls handleClose on socket close', () => {
      // Arrange
      controller.sessionClient(mockSocket as never, mockReq as never);
      const closeHandler = captureSocketHandler('close');

      // Act
      closeHandler();

      // Assert
      expect(mockService.handleClose).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });
  });

  describe('muteSession', (it) => {
    const validPayload = {
      sessionId: TEST_SESSION_ID,
      scopes: [SessionTokenScope.SEND_AUDIO],
      clientId: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    function makeMuteReq(overrides?: {
      authorization?: string;
      sessionId?: string;
      muted?: boolean;
    }) {
      return {
        params: { sessionId: overrides?.sessionId ?? TEST_SESSION_ID },
        headers: {
          authorization: overrides?.authorization ?? 'Bearer valid-token',
        },
        body: { muted: overrides?.muted ?? true },
      };
    }

    function makeMuteRes() {
      return {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        code: vi.fn().mockReturnThis(),
      };
    }

    it('returns 401 when authorization header is missing', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue(null);
      const req = makeMuteReq({ authorization: '' });
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ message: 'Unauthorized' });
    });

    it('returns 401 when token is invalid', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue(null);
      const req = makeMuteReq({ authorization: 'Bearer bad-token' });
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ message: 'Unauthorized' });
    });

    it('returns 401 when token lacks SEND_AUDIO scope', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        ...validPayload,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
      });
      const req = makeMuteReq();
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ message: 'Unauthorized' });
    });

    it('returns 401 when token sessionId does not match param sessionId', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        ...validPayload,
        sessionId: 'different-session-id',
      });
      const req = makeMuteReq();
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ message: 'Unauthorized' });
    });

    it('returns 404 when session is not found', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue(validPayload);
      mockTranscriptionServiceManager.setMuted.mockReturnValue(false);
      const req = makeMuteReq();
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.send).toHaveBeenCalledWith({ message: 'Session not found' });
    });

    it('returns 200 and calls setMuted when valid', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue(validPayload);
      mockTranscriptionServiceManager.setMuted.mockReturnValue(true);
      const req = makeMuteReq({ muted: true });
      const res = makeMuteRes();

      // Act
      await controller.muteSession(req as never, res as never);

      // Assert
      expect(mockTranscriptionServiceManager.setMuted).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        true,
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({});
    });
  });
});
