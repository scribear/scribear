import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { createRedisSubscriber } from '@scribear/scribear-redis';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/transcription-service-schema';

import { TranscriptionServiceManager } from '#src/server/features/session-streaming/transcription-service-manager.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

vi.mock('@scribear/transcription-service-client', () => ({
  createTranscriptionServiceClient: vi.fn(),
}));

vi.mock('@scribear/session-manager-client', () => ({
  createSessionManagerClient: vi.fn(),
}));

vi.mock('@scribear/scribear-redis', () => ({
  createRedisSubscriber: vi.fn(),
}));

const TEST_SESSION_ID = 'test-session-id';
const TEST_CONFIG = {
  transcriptionServiceAddress: 'http://localhost:4000',
  transcriptionServiceApiKey: 'transcription-api-key',
  sessionManagerAddress: 'http://localhost:8001',
  nodeServerKey: 'node-server-key',
  redisUrl: 'redis://localhost:6379',
};
const TEST_SESSION_CONFIG = {
  data: {
    transcriptionProviderKey: 'whisper',
    transcriptionProviderConfig: { sample_rate: 16000, num_channels: 1 },
    endTimeUnixMs: null,
  },
  status: 200,
};

describe('TranscriptionServiceManager', () => {
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
    onSessionStatus: Mock;
    emitSessionStatus: Mock;
    onSessionEnd: Mock;
    emitSessionEnd: Mock;
  };
  let mockSessionManagerClient: {
    getSessionConfig: Mock;
  };
  let mockRedisSubscriber: {
    subscribe: Mock;
    unsubscribe: Mock;
    disconnect: Mock;
  };
  let manager: TranscriptionServiceManager;

  function captureWsHandler(event: string): (...args: unknown[]) => void {
    const call = mockWsClient.on.mock.calls.find(
      (c: unknown[]) => c[0] === event,
    );
    return call![1];
  }

  beforeEach(() => {
    vi.useFakeTimers();

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
      onSessionStatus: vi.fn(),
      emitSessionStatus: vi.fn(),
      onSessionEnd: vi.fn(),
      emitSessionEnd: vi.fn(),
    };
    mockSessionManagerClient = {
      getSessionConfig: vi.fn().mockResolvedValue([TEST_SESSION_CONFIG, null]),
    };
    mockRedisSubscriber = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      disconnect: vi.fn(),
    };

    vi.mocked(createTranscriptionServiceClient).mockReturnValue({
      transcriptionStream: vi
        .fn()
        .mockResolvedValue([mockWsClient, null]) as never,
    });
    vi.mocked(createSessionManagerClient).mockReturnValue(
      mockSessionManagerClient as never,
    );
    vi.mocked(createRedisSubscriber).mockReturnValue(
      mockRedisSubscriber as never,
    );

    manager = new TranscriptionServiceManager(
      createMockLogger() as never,
      TEST_CONFIG,
      mockEventBus as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', (it) => {
    it('creates session manager client with configured address', () => {
      // Assert
      expect(createSessionManagerClient).toHaveBeenCalledWith(
        TEST_CONFIG.sessionManagerAddress,
      );
    });

    it('creates redis subscriber with session event channel and configured url', () => {
      // Assert
      expect(createRedisSubscriber).toHaveBeenCalledWith(
        expect.objectContaining({ schema: expect.anything() }),
        TEST_CONFIG.redisUrl,
      );
    });
  });

  describe('registerSession', (it) => {
    it('fetches config from session manager', async () => {
      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(
        mockSessionManagerClient.getSessionConfig,
      ).toHaveBeenCalledExactlyOnceWith({
        params: { sessionId: TEST_SESSION_ID },
        headers: { authorization: `Bearer ${TEST_CONFIG.nodeServerKey}` },
      });
    });

    it('connects to transcription service and sends auth and config', async () => {
      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(createTranscriptionServiceClient).toHaveBeenCalledWith(
        TEST_CONFIG.transcriptionServiceAddress,
      );
      expect(mockWsClient.send).toHaveBeenCalledWith({
        type: TranscriptionStreamClientMessageType.AUTH,
        api_key: TEST_CONFIG.transcriptionServiceApiKey,
      });
      expect(mockWsClient.send).toHaveBeenCalledWith({
        type: TranscriptionStreamClientMessageType.CONFIG,
        config: TEST_SESSION_CONFIG.data.transcriptionProviderConfig,
      });
    });

    it('subscribes to Redis for session end events', async () => {
      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(mockRedisSubscriber.subscribe).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        TEST_SESSION_ID,
      );
    });

    it('emits session status after connecting', async () => {
      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(mockEventBus.emitSessionStatus).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        {
          transcriptionServiceConnected: true,
          sourceDeviceConnected: true,
        },
      );
    });

    it('subscribes to audio chunks and forwards them via sendBinary', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
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
      await manager.registerSession(TEST_SESSION_ID);
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
        { text: ['hello'], starts: [0], ends: [100] },
      );
    });

    it('routes FINAL_TRANSCRIPT messages to event bus', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
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
        { text: ['done'], starts: null, ends: null },
      );
    });

    it('increments client count on second registration without re-fetching config', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      mockSessionManagerClient.getSessionConfig.mockClear();

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(mockSessionManagerClient.getSessionConfig).not.toHaveBeenCalled();
    });


    it('cancels grace timer when a new client registers during grace period', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      manager.unregisterSession(TEST_SESSION_ID);

      // Act
      await manager.registerSession(TEST_SESSION_ID);
      vi.advanceTimersByTime(30_000);

      // Assert
      expect(mockWsClient.close).not.toHaveBeenCalled();
    });

    it('retries initialization when config fetch fails and other clients joined', async () => {
      // Arrange
      let resolveConfig!: (value: unknown) => void;
      mockSessionManagerClient.getSessionConfig.mockReturnValue(
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
      );

      // Act - first device starts registering (awaits config fetch)
      const registerPromise = manager.registerSession(TEST_SESSION_ID);

      // Second device joins while first is still fetching
      await manager.registerSession(TEST_SESSION_ID);

      // First device's config fetch fails
      resolveConfig([null, new Error('fetch failed')]);
      await registerPromise;

      // Assert
      mockSessionManagerClient.getSessionConfig.mockResolvedValue([
        TEST_SESSION_CONFIG,
        null,
      ]);
      mockSessionManagerClient.getSessionConfig.mockClear();
      vi.advanceTimersByTime(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSessionManagerClient.getSessionConfig).toHaveBeenCalledOnce();
    });

    it('schedules retry and emits disconnected status when config fetch fails', async () => {
      // Arrange
      mockSessionManagerClient.getSessionConfig.mockResolvedValue([
        null,
        new Error('fetch failed'),
      ]);

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert - status emitted with transcriptionServiceConnected: false
      expect(mockEventBus.emitSessionStatus).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: true,
        },
      );

      // Assert - schedules retry
      mockSessionManagerClient.getSessionConfig.mockResolvedValue([TEST_SESSION_CONFIG, null]);
      mockSessionManagerClient.getSessionConfig.mockClear();
      vi.advanceTimersByTime(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSessionManagerClient.getSessionConfig).toHaveBeenCalledOnce();
    });
  });

  describe('registerSession with timed session', (it) => {
    it('sets end timer when endTimeUnixMs is in the future', async () => {
      // Arrange
      const futureMs = Date.now() + 60_000;
      mockSessionManagerClient.getSessionConfig.mockResolvedValue([
        {
          data: {
            ...TEST_SESSION_CONFIG.data,
            endTimeUnixMs: futureMs,
          },
          status: 200,
        },
        null,
      ]);

      // Act
      await manager.registerSession(TEST_SESSION_ID);
      vi.advanceTimersByTime(60_000);

      // Assert
      expect(mockEventBus.emitSessionEnd).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });

    it('ends session immediately when endTimeUnixMs is in the past', async () => {
      // Arrange
      mockSessionManagerClient.getSessionConfig.mockResolvedValue([
        {
          data: {
            ...TEST_SESSION_CONFIG.data,
            endTimeUnixMs: Date.now() - 1000,
          },
          status: 200,
        },
        null,
      ]);

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      expect(mockEventBus.emitSessionEnd).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });
  });

  describe('registerSession Redis session end', (it) => {
    it('ends session when Redis session end event fires', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      const redisCallback = mockRedisSubscriber.subscribe.mock
        .calls[0]![0] as () => void;

      // Act
      redisCallback();

      // Assert
      expect(mockEventBus.emitSessionEnd).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
      expect(mockWsClient.close).toHaveBeenCalledExactlyOnceWith(1000);
      expect(mockRedisSubscriber.unsubscribe).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });
  });

  describe('registerSession reconnect', (it) => {
    it('schedules reconnect with exponential backoff on WS close', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      const closeHandler = captureWsHandler('close');

      // Act
      closeHandler();

      // Assert
      expect(mockEventBus.emitSessionStatus).toHaveBeenLastCalledWith(
        TEST_SESSION_ID,
        {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: true,
        },
      );

      // Act
      vi.mocked(createTranscriptionServiceClient).mockClear();
      vi.advanceTimersByTime(1_000);
      await vi.advanceTimersByTimeAsync(0);

      // Assert - reconnected
      expect(createTranscriptionServiceClient).toHaveBeenCalledOnce();
    });

    it('schedules reconnect and emits disconnected status on initial connection failure', async () => {
      // Arrange
      vi.mocked(createTranscriptionServiceClient).mockReturnValue({
        transcriptionStream: vi
          .fn()
          .mockResolvedValue([null, new Error('connection failed')]) as never,
      });

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert - status emitted with transcriptionServiceConnected: false
      expect(mockEventBus.emitSessionStatus).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        {
          transcriptionServiceConnected: false,
          sourceDeviceConnected: true,
        },
      );

      // Assert - schedules reconnect
      vi.mocked(createTranscriptionServiceClient).mockReturnValue({
        transcriptionStream: vi
          .fn()
          .mockResolvedValue([mockWsClient, null]) as never,
      });
      vi.advanceTimersByTime(1_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(createTranscriptionServiceClient).toHaveBeenCalled();
    });
  });

  describe('getSessionStatus', (it) => {
    it('returns null for unknown session', () => {
      // Act / Assert
      expect(manager.getSessionStatus('unknown-session')).toBeNull();
    });

    it('returns current status for a registered session', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);

      // Act
      const status = manager.getSessionStatus(TEST_SESSION_ID);

      // Assert
      expect(status).toEqual({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });

    it('reflects disconnected transcription service after WS close', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      const closeHandler = captureWsHandler('close');
      closeHandler();

      // Act
      const status = manager.getSessionStatus(TEST_SESSION_ID);

      // Assert
      expect(status).toEqual({
        transcriptionServiceConnected: false,
        sourceDeviceConnected: true,
      });
    });
  });

  describe('unregisterSession', (it) => {
    it('does nothing for unknown session', () => {
      // Act / Assert
      expect(() => {
        manager.unregisterSession('unknown-session');
      }).not.toThrow();
    });

    it('starts grace period when last client disconnects', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);

      // Act
      manager.unregisterSession(TEST_SESSION_ID);

      // Assert
      expect(mockWsClient.close).not.toHaveBeenCalled();

      // Act
      vi.advanceTimersByTime(30_000);

      // Assert
      expect(mockWsClient.close).toHaveBeenCalledExactlyOnceWith(1000);
      expect(mockRedisSubscriber.unsubscribe).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
      );
    });

    it('does not clean up when multiple clients remain', async () => {
      // Arrange
      await manager.registerSession(TEST_SESSION_ID);
      await manager.registerSession(TEST_SESSION_ID);

      // Act
      manager.unregisterSession(TEST_SESSION_ID);
      vi.advanceTimersByTime(30_000);

      // Assert
      expect(mockWsClient.close).not.toHaveBeenCalled();
    });
  });
});
