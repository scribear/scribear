import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/transcription-service-schema';

import { TranscriptionService } from '#src/server/features/session-streaming/transcription.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

vi.mock('@scribear/transcription-service-client', () => ({
  createTranscriptionServiceClient: vi.fn(),
}));

const TEST_SESSION_ID = 'test-session-id';
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'sk-test' };
const TEST_CONFIG = {
  address: 'http://localhost:4000',
  apiKey: 'transcription-api-key',
};

describe('TranscriptionService', () => {
  let mockWsClient: {
    send: Mock;
    sendBinary: Mock;
    on: Mock;
    close: Mock;
  };
  let mockEventBus: {
    onAudioChunk: Mock;
    emitAudioChunk: Mock;
    onIpTranscript: Mock;
    emitIpTranscript: Mock;
    onFinalTranscript: Mock;
    emitFinalTranscript: Mock;
  };
  let service: TranscriptionService;

  function captureWsHandler(event: string): (...args: unknown[]) => void {
    const call = mockWsClient.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    return call![1];
  }

  beforeEach(() => {
    mockWsClient = {
      send: vi.fn(),
      sendBinary: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    };
    mockEventBus = {
      onAudioChunk: vi.fn().mockReturnValue(vi.fn()),
      emitAudioChunk: vi.fn(),
      onIpTranscript: vi.fn(),
      emitIpTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      emitFinalTranscript: vi.fn(),
    };

    vi.mocked(createTranscriptionServiceClient).mockReturnValue({
      transcriptionStream: vi
        .fn()
        .mockResolvedValue([mockWsClient, null]) as never,
    });

    service = new TranscriptionService(
      createMockLogger() as never,
      TEST_CONFIG,
      mockEventBus as never,
    );
  });

  describe('addClient', (it) => {
    it('tracks new session with client count 1', () => {
      // Act
      service.addClient(TEST_SESSION_ID);

      // Assert
      service.removeClient(TEST_SESSION_ID);
      // If addClient set count to 1, removeClient decrements to 0 and cleans up.
      // A second removeClient is a no-op (session already removed).
      service.removeClient(TEST_SESSION_ID);
    });

    it('increments client count for existing session', () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);

      // Act
      service.addClient(TEST_SESSION_ID);

      // Assert
      service.removeClient(TEST_SESSION_ID);
      // Second removeClient decrements to 0, triggers cleanup
      service.removeClient(TEST_SESSION_ID);
      // Third is a no-op
      service.removeClient(TEST_SESSION_ID);
    });
  });

  describe('removeClient', (it) => {
    it('does nothing for unknown session', () => {
      // Act / Assert
      expect(() => {
        service.removeClient('unknown-session');
      }).not.toThrow();
    });
  });

  describe('configureSession', (it) => {
    it('connects to transcription service and sends auth and config', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);

      // Act
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );

      // Assert
      expect(createTranscriptionServiceClient).toHaveBeenCalledExactlyOnceWith(
        TEST_CONFIG.address,
      );
      expect(mockWsClient.send).toHaveBeenCalledWith({
        type: TranscriptionStreamClientMessageType.AUTH,
        api_key: TEST_CONFIG.apiKey,
      });
      expect(mockWsClient.send).toHaveBeenCalledWith({
        type: TranscriptionStreamClientMessageType.CONFIG,
        config: TEST_PROVIDER_CONFIG,
      });
    });

    it('subscribes to audio chunks and forwards them via sendBinary', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );
      const audioCallback = mockEventBus.onAudioChunk.mock.calls[0]![1] as (
        chunk: Buffer,
      ) => void;
      const chunk = Buffer.from('audio');

      // Act
      audioCallback(chunk);

      // Assert
      expect(mockWsClient.sendBinary).toHaveBeenCalledExactlyOnceWith(chunk);
    });

    it('routes IP_TRANSCRIPT messages to event bus', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );
      const messageHandler = captureWsHandler('message');

      // Act
      messageHandler({
        type: TranscriptionStreamServerMessageType.IP_TRANSCRIPT,
        text: ['hello'],
        starts: [0],
        ends: [100],
      });

      // Assert
      expect(mockEventBus.emitIpTranscript).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        {
          text: ['hello'],
          starts: [0],
          ends: [100],
        },
      );
    });

    it('routes FINAL_TRANSCRIPT messages to event bus', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );
      const messageHandler = captureWsHandler('message');

      // Act
      messageHandler({
        type: TranscriptionStreamServerMessageType.FINAL_TRANSCRIPT,
        text: ['done'],
        starts: null,
        ends: null,
      });

      // Assert
      expect(mockEventBus.emitFinalTranscript).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        {
          text: ['done'],
          starts: null,
          ends: null,
        },
      );
    });

    it('is a no-op if session is already configured', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );
      vi.mocked(createTranscriptionServiceClient).mockClear();

      // Act
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );

      // Assert
      expect(createTranscriptionServiceClient).not.toHaveBeenCalled();
    });

    it('throws when connection to transcription service fails', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      vi.mocked(createTranscriptionServiceClient).mockReturnValue({
        transcriptionStream: vi
          .fn()
          .mockResolvedValue([null, new Error('connection failed')]) as never,
      });

      // Act / Assert
      await expect(
        service.configureSession(
          TEST_SESSION_ID,
          TEST_PROVIDER_KEY,
          TEST_PROVIDER_CONFIG as never,
        ),
      ).rejects.toThrow('Failed to connect to transcription service');
    });

    it('cleans up session when transcription WS closes', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      const mockUnsub = vi.fn();
      mockEventBus.onAudioChunk.mockReturnValue(mockUnsub);
      await service.configureSession(
        TEST_SESSION_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG as never,
      );
      const closeHandler = captureWsHandler('close');

      // Act
      closeHandler();

      // Assert
      expect(mockUnsub).toHaveBeenCalledOnce();
    });
  });
});
