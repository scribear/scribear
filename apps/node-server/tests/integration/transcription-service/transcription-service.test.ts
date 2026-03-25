import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, inject, vi } from 'vitest';

import { TranscriptionService } from '#src/server/features/session-streaming/transcription.service.js';
import { StreamingEventBusService } from '#src/server/features/session-streaming/streaming-event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const TEST_SESSION_ID = 'transcription-integration-test';
const DEBUG_PROVIDER_KEY = 'debug';
const DEBUG_PROVIDER_CONFIG = { sample_rate: 48000, num_channels: 1 };

const TEST_AUDIO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../test_audio_files/chords/mono_f64le.wav',
);

function waitForEvent<T>(
  eventBus: StreamingEventBusService,
  sessionId: string,
  type: 'ip' | 'final',
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${type} transcript`));
    }, timeoutMs);

    const sub = type === 'final'
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

    const unsub = () => { sub(); };
  });
}

describe('TranscriptionService Integration', () => {
  let eventBus: StreamingEventBusService;
  let service: TranscriptionService;

  beforeEach(() => {
    eventBus = new StreamingEventBusService();
    service = new TranscriptionService(
      createMockLogger() as never,
      inject('transcriptionServiceConfig'),
      eventBus,
    );
  });

  afterEach(() => {
    service.removeClient(TEST_SESSION_ID);
  });

  describe('configureSession', (it) => {
    it('connects to transcription service and receives initial transcript', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');

      // Act
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );

      // Assert
      const event = await finalPromise as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );
    });

    it('is a no-op when session is already configured', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      const firstFinalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );
      await firstFinalPromise;

      // Act
      const secondFinalSpy = vi.fn();
      eventBus.onFinalTranscript(TEST_SESSION_ID, secondFinalSpy);

      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );

      // Assert
      await new Promise((r) => setTimeout(r, 500));
      expect(secondFinalSpy).not.toHaveBeenCalled();
    });
  });

  describe('audio chunk routing', (it) => {
    it('forwards audio chunks to transcription service and receives transcript', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );
      await finalPromise;

      const ipPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'ip');
      const audioData = fs.readFileSync(TEST_AUDIO_PATH);

      // Act
      eventBus.emitAudioChunk(TEST_SESSION_ID, audioData);

      // Assert
      const event = await ipPromise as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );
    });
  });

  describe('client lifecycle', (it) => {
    it('cleans up when last client is removed', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );
      await finalPromise;

      // Act
      service.removeClient(TEST_SESSION_ID);

      // Assert
      service.addClient(TEST_SESSION_ID);
      const newFinalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );
      const event = await newFinalPromise as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );
    });

    it('does not clean up when other clients remain', async () => {
      // Arrange
      service.addClient(TEST_SESSION_ID);
      service.addClient(TEST_SESSION_ID);
      const finalPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'final');
      await service.configureSession(
        TEST_SESSION_ID,
        DEBUG_PROVIDER_KEY,
        DEBUG_PROVIDER_CONFIG as never,
      );
      await finalPromise;

      // Act
      service.removeClient(TEST_SESSION_ID);

      // Assert
      const ipPromise = waitForEvent(eventBus, TEST_SESSION_ID, 'ip');
      const audioData = fs.readFileSync(TEST_AUDIO_PATH);
      eventBus.emitAudioChunk(TEST_SESSION_ID, audioData);

      const event = await ipPromise as { text: string[] };
      expect(event.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );

      // Cleanup remaining client
      service.removeClient(TEST_SESSION_ID);
    });
  });
});
