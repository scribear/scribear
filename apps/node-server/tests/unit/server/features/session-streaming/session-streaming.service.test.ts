import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { SessionTokenScope } from '@scribear/node-server-schema';

import { SessionStreamingService } from '#src/server/features/session-streaming/session-streaming.service.js';

const TEST_SESSION_ID = 'test-session-id';
const TEST_SESSION_TOKEN = 'valid.jwt.token';
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');
const TOKEN_EXP_UNIX = FAKE_NOW.getTime() / 1000 + 300;
const TEST_CLIENT_ID = 'client-123';

describe('SessionStreamingService', () => {
  let mockJwtService: { verifySessionToken: Mock };
  let mockEventBus: {
    onAudioChunk: Mock;
    emitAudioChunk: Mock;
    onIpTranscript: Mock;
    emitIpTranscript: Mock;
    onFinalTranscript: Mock;
    emitFinalTranscript: Mock;
    onSessionStatus: Mock;
    emitSessionStatus: Mock;
    onSessionEnd: Mock;
    emitSessionEnd: Mock;
  };
  let mockTranscriptionServiceManager: {
    registerSession: Mock;
    unregisterSession: Mock;
  };
  let service: SessionStreamingService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockJwtService = {
      verifySessionToken: vi.fn(),
    };
    mockEventBus = {
      onAudioChunk: vi.fn(),
      emitAudioChunk: vi.fn(),
      onIpTranscript: vi.fn().mockReturnValue(vi.fn()),
      emitIpTranscript: vi.fn(),
      onFinalTranscript: vi.fn().mockReturnValue(vi.fn()),
      emitFinalTranscript: vi.fn(),
      onSessionStatus: vi.fn().mockReturnValue(vi.fn()),
      emitSessionStatus: vi.fn(),
      onSessionEnd: vi.fn().mockReturnValue(vi.fn()),
      emitSessionEnd: vi.fn(),
    };
    mockTranscriptionServiceManager = {
      registerSession: vi.fn().mockResolvedValue(undefined),
      unregisterSession: vi.fn(),
    };

    service = new SessionStreamingService(
      mockJwtService as never,
      mockEventBus as never,
      mockTranscriptionServiceManager as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startAuthTimeout', (it) => {
    it('emits close after 1 second if not authenticated', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);

      // Act
      service.startAuthTimeout();
      vi.advanceTimersByTime(1_000);

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Authentication timeout',
      );
    });

    it('does not emit close before 1 seconds', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);

      // Act
      service.startAuthTimeout();
      vi.advanceTimersByTime(999);

      // Assert
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleClientAuth', (it) => {
    it('emits close when token verification fails', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue(null);

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {});

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Invalid or expired token',
      );
    });

    it('emits close when session ID does not match token', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: 'different-session-id',
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {});

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Invalid or expired token',
      );
    });

    it('emits close when required SEND_AUDIO scope is missing', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Missing required scope: SEND_AUDIO',
      );
    });

    it('emits close when required RECEIVE_TRANSCRIPTIONS scope is missing', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Missing required scope: RECEIVE_TRANSCRIPTIONS',
      );
    });

    it('clears auth timeout on successful auth', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.startAuthTimeout();

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      vi.advanceTimersByTime(10_000);

      // Assert
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('registers session with transcription service manager when SEND_AUDIO scope is present', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Assert
      expect(
        mockTranscriptionServiceManager.registerSession,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
    });

    it('subscribes to transcript events when RECEIVE_TRANSCRIPTIONS scope is present', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Assert
      expect(mockEventBus.onIpTranscript).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        expect.any(Function),
      );
      expect(mockEventBus.onFinalTranscript).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        expect.any(Function),
      );
    });

    it('emits ip-transcript event when event bus fires', () => {
      // Arrange
      const transcriptSpy = vi.fn();
      service.on('ip-transcript', transcriptSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      const ipCallback = mockEventBus.onIpTranscript.mock.calls[0]![1] as (
        event: unknown,
      ) => void;
      const event = { text: ['hello'], starts: [0], ends: [100] };

      // Act
      ipCallback(event);

      // Assert
      expect(transcriptSpy).toHaveBeenCalledExactlyOnceWith(event);
    });

    it('emits final-transcript event when event bus fires', () => {
      // Arrange
      const transcriptSpy = vi.fn();
      service.on('final-transcript', transcriptSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      const finalCallback = mockEventBus.onFinalTranscript.mock
        .calls[0]![1] as (event: unknown) => void;
      const event = { text: ['done'], starts: null, ends: null };

      // Act
      finalCallback(event);

      // Assert
      expect(transcriptSpy).toHaveBeenCalledExactlyOnceWith(event);
    });

    it('emits close when JWT expires', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      vi.advanceTimersByTime(300 * 1000);

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Session token expired',
      );
    });

    it('subscribes to session status events on first auth', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Assert
      expect(mockEventBus.onSessionStatus).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        expect.any(Function),
      );
    });

    it('emits session-status event when event bus fires', () => {
      // Arrange
      const statusSpy = vi.fn();
      service.on('session-status', statusSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      const statusCallback = mockEventBus.onSessionStatus.mock.calls[0]![1] as (
        event: unknown,
      ) => void;
      const event = {
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      };

      // Act
      statusCallback(event);

      // Assert
      expect(statusSpy).toHaveBeenCalledExactlyOnceWith(event);
    });

    it('subscribes to session end events on first auth', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Assert
      expect(mockEventBus.onSessionEnd).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        expect.any(Function),
      );
    });

    it('emits close with 1000 when session end event fires', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      const endCallback = mockEventBus.onSessionEnd.mock.calls[0]![1] as (
        ...args: unknown[]
      ) => void;

      // Act
      endCallback();

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(1000, 'Session ended');
    });
  });

  describe('handleClientAuth re-auth', (it) => {
    it('resets JWT expiry timeout on re-auth without re-subscribing', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      const newExp = TOKEN_EXP_UNIX + 300;
      mockJwtService.verifySessionToken
        .mockReturnValueOnce({
          sessionId: TEST_SESSION_ID,
          clientId: TEST_CLIENT_ID,
          scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
          exp: TOKEN_EXP_UNIX,
        })
        .mockReturnValueOnce({
          sessionId: TEST_SESSION_ID,
          clientId: TEST_CLIENT_ID,
          scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
          exp: newExp,
        });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      // Advance past original expiry
      vi.advanceTimersByTime(200 * 1000);
      // Re-auth with new token
      service.handleClientAuth(TEST_SESSION_ID, 'new.jwt.token', {
        receiveTranscriptions: true,
      });
      // Advance past original expiry but before new expiry
      vi.advanceTimersByTime(200 * 1000);

      // Assert - should not have closed
      expect(closeSpy).not.toHaveBeenCalled();

      // Assert - should not re-subscribe to events
      expect(mockEventBus.onIpTranscript).toHaveBeenCalledOnce();
      expect(mockEventBus.onSessionStatus).toHaveBeenCalledOnce();
      expect(mockEventBus.onSessionEnd).toHaveBeenCalledOnce();
    });

    it('does not re-register session with transcription service manager on re-auth', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Assert
      expect(
        mockTranscriptionServiceManager.registerSession,
      ).toHaveBeenCalledOnce();
    });
  });

  describe('handleAudioChunk', (it) => {
    it('ignores chunk when SEND_AUDIO not granted', () => {
      // Arrange
      const chunk = Buffer.from('audio');

      // Act
      service.handleAudioChunk(TEST_SESSION_ID, chunk);

      // Assert
      expect(mockEventBus.emitAudioChunk).not.toHaveBeenCalled();
    });

    it('forwards chunk to event bus when SEND_AUDIO granted', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      const chunk = Buffer.from('audio');

      // Act
      service.handleAudioChunk(TEST_SESSION_ID, chunk);

      // Assert
      expect(mockEventBus.emitAudioChunk).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        chunk,
      );
    });
  });

  describe('handleClose', (it) => {
    it('unregisters session from transcription service manager when SEND_AUDIO was granted', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);

      // Assert
      expect(
        mockTranscriptionServiceManager.unregisterSession,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
    });

    it('does not unregister when SEND_AUDIO was not granted', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);

      // Assert
      expect(
        mockTranscriptionServiceManager.unregisterSession,
      ).not.toHaveBeenCalled();
    });

    it('unsubscribes transcript listeners on close', () => {
      // Arrange
      const mockUnsubIp = vi.fn();
      const mockUnsubFinal = vi.fn();
      mockEventBus.onIpTranscript.mockReturnValue(mockUnsubIp);
      mockEventBus.onFinalTranscript.mockReturnValue(mockUnsubFinal);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);

      // Assert
      expect(mockUnsubIp).toHaveBeenCalledOnce();
      expect(mockUnsubFinal).toHaveBeenCalledOnce();
    });

    it('clears JWT expiry timeout on close', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_CLIENT_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);
      vi.advanceTimersByTime(300 * 1000);

      // Assert
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });
});
