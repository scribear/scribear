import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, inject } from 'vitest';

import { createRedisPublisher } from '@scribear/scribear-redis';
import {
  SESSION_EVENT_CHANNEL,
  SessionChannelEventType,
} from '@scribear/session-manager-schema';

import type { SessionStatusEvent } from '#src/server/features/session-streaming/streaming-event-bus.service.js';
import { StreamingEventBusService } from '#src/server/features/session-streaming/streaming-event-bus.service.js';
import {
  TranscriptionServiceManager,
  type TranscriptionServiceManagerConfig,
} from '#src/server/features/session-streaming/transcription-service-manager.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const TEST_SESSION_ID = 'tsm-integration-test';

const TEST_AUDIO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../test_audio_files/chords/mono_f64le.wav',
);

function waitForEvent<T>(
  eventBus: StreamingEventBusService,
  sessionId: string,
  type: 'ip' | 'final',
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${type} transcript`));
    }, timeoutMs);

    const unsub =
      type === 'final'
        ? eventBus.onFinalTranscript(sessionId, (event) => {
            clearTimeout(timeout);
            unsub();
            resolve(event as T);
          })
        : eventBus.onIpTranscript(sessionId, (event) => {
            clearTimeout(timeout);
            unsub();
            resolve(event as T);
          });
  });
}

function waitForSessionStatus(
  eventBus: StreamingEventBusService,
  sessionId: string,
  predicate: (event: SessionStatusEvent) => boolean,
  timeoutMs = 5_000,
): Promise<SessionStatusEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for session status'));
    }, timeoutMs);

    const unsub = eventBus.onSessionStatus(sessionId, (event) => {
      if (predicate(event)) {
        clearTimeout(timeout);
        unsub();
        resolve(event);
      }
    });
  });
}

function waitForSessionEnd(
  eventBus: StreamingEventBusService,
  sessionId: string,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for session end'));
    }, timeoutMs);
    eventBus.onSessionEnd(sessionId, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function createManager(
  eventBus: StreamingEventBusService,
  config: TranscriptionServiceManagerConfig,
): TranscriptionServiceManager {
  return new TranscriptionServiceManager(
    createMockLogger() as never,
    config,
    eventBus,
  );
}

describe('TranscriptionServiceManager Integration', () => {
  let eventBus: StreamingEventBusService;
  let manager: TranscriptionServiceManager;
  const config = inject('transcriptionServiceManagerConfig');

  beforeEach(() => {
    eventBus = new StreamingEventBusService();
    manager = createManager(eventBus, config);
  });

  afterEach(() => {
    manager.unregisterSession(TEST_SESSION_ID);
  });

  describe('registerSession', (it) => {
    it('connects to transcription service and receives initial transcript', async () => {
      // Arrange
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      const event = (await finalPromise) as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );
    });

    it('emits session status as connected after registering', async () => {
      // Arrange
      const statusPromise = waitForSessionStatus(
        eventBus,
        TEST_SESSION_ID,
        (e) => e.transcriptionServiceConnected,
      );

      // Act
      await manager.registerSession(TEST_SESSION_ID);

      // Assert
      await statusPromise;
    });
  });

  describe('audio chunk routing', (it) => {
    it('forwards audio chunks and receives transcript', async () => {
      // Arrange
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);
      await finalPromise;

      const ipPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'ip');
      const audioData = fs.readFileSync(TEST_AUDIO_PATH);

      // Act
      eventBus.emitAudioChunk(TEST_SESSION_ID, audioData);

      // Assert
      const event = (await ipPromise) as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );
    });
  });

  describe('session end via Redis', (it) => {
    it('emits session end when Redis session end event is published', async () => {
      // Arrange
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);
      await finalPromise;
      const sessionEndPromise = waitForSessionEnd(eventBus, TEST_SESSION_ID);

      // Act
      const publisher = createRedisPublisher(
        SESSION_EVENT_CHANNEL,
        config.redisUrl,
      );
      await new Promise((r) => setTimeout(r, 100));
      await publisher.publish(
        {
          type: SessionChannelEventType.SESSION_END,
          endTimeUnixMs: Date.now(),
        },
        TEST_SESSION_ID,
      );

      // Assert
      await sessionEndPromise;
      await publisher.disconnect();
    });

    it('stops forwarding audio after session end', async () => {
      // Arrange
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);
      await finalPromise;
      const sessionEndPromise = waitForSessionEnd(eventBus, TEST_SESSION_ID);

      const publisher = createRedisPublisher(
        SESSION_EVENT_CHANNEL,
        config.redisUrl,
      );
      await new Promise((r) => setTimeout(r, 100));
      await publisher.publish(
        {
          type: SessionChannelEventType.SESSION_END,
          endTimeUnixMs: Date.now(),
        },
        TEST_SESSION_ID,
      );
      await sessionEndPromise;
      await publisher.disconnect();

      // Act - send audio after session end
      const transcriptSpy: unknown[] = [];
      eventBus.onIpTranscript(TEST_SESSION_ID, (e) => transcriptSpy.push(e));
      eventBus.onFinalTranscript(TEST_SESSION_ID, (e) => transcriptSpy.push(e));
      const audioData = fs.readFileSync(TEST_AUDIO_PATH);
      eventBus.emitAudioChunk(TEST_SESSION_ID, audioData);

      // Assert - no transcripts received
      await new Promise((r) => setTimeout(r, 500));
      expect(transcriptSpy).toHaveLength(0);
    });
  });

  describe('client lifecycle', (it) => {
    it('does not clean up when other clients remain', async () => {
      // Arrange
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);
      await manager.registerSession(TEST_SESSION_ID);
      await finalPromise;

      // Act
      manager.unregisterSession(TEST_SESSION_ID);

      // Assert - still receives transcripts
      const ipPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'ip');
      const audioData = fs.readFileSync(TEST_AUDIO_PATH);
      eventBus.emitAudioChunk(TEST_SESSION_ID, audioData);

      const event = (await ipPromise) as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );

      // Cleanup remaining client
      manager.unregisterSession(TEST_SESSION_ID);
    });

    it('re-registers and works after session end', async () => {
      // Arrange - register, connect, then end via Redis
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);
      await finalPromise;
      const sessionEndPromise = waitForSessionEnd(eventBus, TEST_SESSION_ID);

      const publisher = createRedisPublisher(
        SESSION_EVENT_CHANNEL,
        config.redisUrl,
      );
      await new Promise((r) => setTimeout(r, 100));
      await publisher.publish(
        {
          type: SessionChannelEventType.SESSION_END,
          endTimeUnixMs: Date.now(),
        },
        TEST_SESSION_ID,
      );
      await sessionEndPromise;
      await publisher.disconnect();

      // Act - re-register the same session
      const newFinalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await manager.registerSession(TEST_SESSION_ID);

      // Assert - receives transcripts on fresh connection
      const event = (await newFinalPromise) as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );
    });
  });

  describe('error handling', (it) => {
    it('does not crash when session config returns 404', async () => {
      // Arrange
      const sessionId = 'not-found-session';

      // Act - should not throw, schedules retry internally
      await manager.registerSession(sessionId);

      // Assert - no session end or crash, just retrying in background
      await new Promise((r) => setTimeout(r, 200));
      manager.unregisterSession(sessionId);
    });

    it('does not crash when session config returns 500', async () => {
      // Arrange
      const sessionId = 'error-session';

      // Act - should not throw, schedules retry internally
      await manager.registerSession(sessionId);

      // Assert - no crash
      await new Promise((r) => setTimeout(r, 200));
      manager.unregisterSession(sessionId);
    });

    it('does not crash when transcription service is unreachable', async () => {
      // Arrange - create manager with bad transcription service address
      const badManager = createManager(eventBus, {
        ...config,
        transcriptionServiceAddress: 'http://localhost:1',
      });

      // Act - should not throw, schedules reconnect internally
      await badManager.registerSession(TEST_SESSION_ID);

      // Assert - no crash, status shows disconnected
      await new Promise((r) => setTimeout(r, 200));
      badManager.unregisterSession(TEST_SESSION_ID);
    });

    it('does not crash when transcription service API key is wrong', async () => {
      // Arrange - create manager with bad API key
      const badManager = createManager(eventBus, {
        ...config,
        transcriptionServiceApiKey: 'wrong-key',
      });
      const statusPromise = waitForSessionStatus(
        eventBus,
        TEST_SESSION_ID,
        (e) => e.transcriptionServiceConnected,
      );

      // Act - connects but auth will fail server-side
      await badManager.registerSession(TEST_SESSION_ID);

      // Assert - initial connection is established (auth failure is async)
      await statusPromise;
      badManager.unregisterSession(TEST_SESSION_ID);
    });

    it('operates two sessions independently', async () => {
      // Arrange
      const sessionA = 'tsm-multi-a';
      const sessionB = 'tsm-multi-b';
      const finalA = waitForEvent(eventBus, sessionA, 'final');
      const finalB = waitForEvent(eventBus, sessionB, 'final');

      // Act
      await manager.registerSession(sessionA);
      await manager.registerSession(sessionB);

      // Assert - both receive initial transcripts independently
      const eventA = (await finalA) as { text: string[] };
      const eventB = (await finalB) as { text: string[] };
      expect(eventA.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );
      expect(eventB.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );

      // Cleanup
      manager.unregisterSession(sessionA);
      manager.unregisterSession(sessionB);
    });
  });
});
