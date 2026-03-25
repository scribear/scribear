import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  AudioSourceServerMessageType,
  SessionClientServerMessageType,
  SessionTokenScope,
} from '@scribear/node-server-schema';

import { SessionStreamingService } from '#src/server/features/session-streaming/session-streaming.service.js';

const TEST_SESSION_ID = 'test-session-id';
const TEST_SESSION_TOKEN = 'valid.jwt.token';
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');
const TOKEN_EXP_UNIX = FAKE_NOW.getTime() / 1000 + 3600;
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'sk-test' };

describe('SessionStreamingService', () => {
  let mockJwtService: { verifySessionToken: Mock };
  let mockEventBus: {
    onAudioChunk: Mock;
    emitAudioChunk: Mock;
    onIpTranscript: Mock;
    emitIpTranscript: Mock;
    onFinalTranscript: Mock;
    emitFinalTranscript: Mock;
  };
  let mockTranscriptionService: {
    addClient: Mock;
    removeClient: Mock;
    configureSession: Mock;
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
    };
    mockTranscriptionService = {
      addClient: vi.fn(),
      removeClient: vi.fn(),
      configureSession: vi.fn().mockResolvedValue(undefined),
    };

    service = new SessionStreamingService(
      mockJwtService as never,
      mockEventBus as never,
      mockTranscriptionService as never,
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

    it('adds client to transcription service when SEND_AUDIO scope is present', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Assert
      expect(
        mockTranscriptionService.addClient,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
    });

    it('subscribes to transcript events when RECEIVE_TRANSCRIPTIONS scope is present', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
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

    it('forwards ip transcript events as SessionClient messages when only RECEIVE_TRANSCRIPTIONS', () => {
      // Arrange
      const sendSpy = vi.fn();
      service.on('send', sendSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });
      const ipCallback = mockEventBus.onIpTranscript.mock.calls[0]![1] as (
        event: unknown,
      ) => void;

      // Act
      ipCallback({ text: ['hello'], starts: [0], ends: [100] });

      // Assert
      expect(sendSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: SessionClientServerMessageType.IP_TRANSCRIPT,
          text: ['hello'],
          starts: [0],
          ends: [100],
        }),
      );
    });

    it('forwards transcript events as AudioSource messages when both scopes present', () => {
      // Arrange
      const sendSpy = vi.fn();
      service.on('send', sendSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [
          SessionTokenScope.SEND_AUDIO,
          SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
        ],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      const finalCallback = mockEventBus.onFinalTranscript.mock
        .calls[0]![1] as (event: unknown) => void;

      // Act
      finalCallback({ text: ['done'], starts: null, ends: null });

      // Assert
      expect(sendSpy).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          type: AudioSourceServerMessageType.FINAL_TRANSCRIPT,
          text: ['done'],
          starts: null,
          ends: null,
        }),
      );
    });

    it('emits close when JWT expires', () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });

      // Act
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });
      vi.advanceTimersByTime(3600 * 1000);

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Session token expired',
      );
    });
  });

  describe('handleAudioSourceConfig', (it) => {
    it('emits close when not authenticated', async () => {
      // Arrange
      const closeSpy = vi.fn();
      service.on('close', closeSpy);

      // Act
      await service.handleAudioSourceConfig(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );

      // Assert
      expect(closeSpy).toHaveBeenCalledExactlyOnceWith(
        1008,
        'Not authenticated',
      );
      expect(mockTranscriptionService.configureSession).not.toHaveBeenCalled();
    });

    it('delegates to transcription service when authenticated', async () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Act
      await service.handleAudioSourceConfig(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );

      // Assert
      expect(
        mockTranscriptionService.configureSession,
      ).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
      );
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
    it('removes client from transcription service when SEND_AUDIO was granted', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
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
        mockTranscriptionService.removeClient,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
    });

    it('does not remove client when SEND_AUDIO was not granted', () => {
      // Arrange
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        receiveTranscriptions: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);

      // Assert
      expect(mockTranscriptionService.removeClient).not.toHaveBeenCalled();
    });

    it('unsubscribes transcript listeners on close', () => {
      // Arrange
      const mockUnsubIp = vi.fn();
      const mockUnsubFinal = vi.fn();
      mockEventBus.onIpTranscript.mockReturnValue(mockUnsubIp);
      mockEventBus.onFinalTranscript.mockReturnValue(mockUnsubFinal);
      mockJwtService.verifySessionToken.mockReturnValue({
        sessionId: TEST_SESSION_ID,
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
        scopes: [SessionTokenScope.SEND_AUDIO],
        exp: TOKEN_EXP_UNIX,
      });
      service.handleClientAuth(TEST_SESSION_ID, TEST_SESSION_TOKEN, {
        sendAudio: true,
      });

      // Act
      service.handleClose(TEST_SESSION_ID);
      vi.advanceTimersByTime(3600 * 1000);

      // Assert
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });
});
