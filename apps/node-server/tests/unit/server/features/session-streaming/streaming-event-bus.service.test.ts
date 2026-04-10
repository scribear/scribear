import { beforeEach, describe, expect, vi } from 'vitest';

import { StreamingEventBusService } from '#src/server/features/session-streaming/streaming-event-bus.service.js';

const TEST_SESSION_ID = 'test-session-id';
const TEST_CHUNK = Buffer.from('audio-data');
const TEST_TRANSCRIPT_EVENT = {
  final: { text: ['hello world'], starts: [0], ends: [1000] },
  inProgress: null,
};
const TEST_SESSION_STATUS_EVENT = {
  transcriptionServiceConnected: true,
  sourceDeviceConnected: true,
};

describe('StreamingEventBusService', () => {
  let bus: StreamingEventBusService;

  beforeEach(() => {
    bus = new StreamingEventBusService();
  });

  describe('emitAudioChunk', (it) => {
    it('calls registered listener with the chunk', () => {
      // Arrange
      const listener = vi.fn();
      bus.onAudioChunk(TEST_SESSION_ID, listener);

      // Act
      bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);

      // Assert
      expect(listener).toHaveBeenCalledExactlyOnceWith(TEST_CHUNK);
    });

    it('calls all listeners registered for the session', () => {
      // Arrange
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      bus.onAudioChunk(TEST_SESSION_ID, listener1);
      bus.onAudioChunk(TEST_SESSION_ID, listener2);

      // Act
      bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);

      // Assert
      expect(listener1).toHaveBeenCalledExactlyOnceWith(TEST_CHUNK);
      expect(listener2).toHaveBeenCalledExactlyOnceWith(TEST_CHUNK);
    });

    it('does not call listeners registered for a different session', () => {
      // Arrange
      const listener = vi.fn();
      bus.onAudioChunk('other-session-id', listener);

      // Act
      bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('does nothing when no listeners are registered', () => {
      // Arrange / Act / Assert
      expect(() => {
        bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);
      }).not.toThrow();
    });
  });

  describe('onAudioChunk unsubscribe', (it) => {
    it('stops calling listener after unsubscribe is called', () => {
      // Arrange
      const listener = vi.fn();
      const unsub = bus.onAudioChunk(TEST_SESSION_ID, listener);
      unsub();

      // Act
      bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not affect other listeners when one is unsubscribed', () => {
      // Arrange
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = bus.onAudioChunk(TEST_SESSION_ID, listener1);
      bus.onAudioChunk(TEST_SESSION_ID, listener2);
      unsub1();

      // Act
      bus.emitAudioChunk(TEST_SESSION_ID, TEST_CHUNK);

      // Assert
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledExactlyOnceWith(TEST_CHUNK);
    });
  });

  describe('emitTranscript', (it) => {
    it('calls registered listener with the event', () => {
      // Arrange
      const listener = vi.fn();
      bus.onTranscript(TEST_SESSION_ID, listener);

      // Act
      bus.emitTranscript(TEST_SESSION_ID, TEST_TRANSCRIPT_EVENT);

      // Assert
      expect(listener).toHaveBeenCalledExactlyOnceWith(TEST_TRANSCRIPT_EVENT);
    });

    it('does not call listeners registered for a different session', () => {
      // Arrange
      const listener = vi.fn();
      bus.onTranscript('other-session-id', listener);

      // Act
      bus.emitTranscript(TEST_SESSION_ID, TEST_TRANSCRIPT_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling listener after unsubscribe', () => {
      // Arrange
      const listener = vi.fn();
      const unsub = bus.onTranscript(TEST_SESSION_ID, listener);
      unsub();

      // Act
      bus.emitTranscript(TEST_SESSION_ID, TEST_TRANSCRIPT_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('emitSessionStatus', (it) => {
    it('calls registered listener with the event', () => {
      // Arrange
      const listener = vi.fn();
      bus.onSessionStatus(TEST_SESSION_ID, listener);

      // Act
      bus.emitSessionStatus(TEST_SESSION_ID, TEST_SESSION_STATUS_EVENT);

      // Assert
      expect(listener).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_STATUS_EVENT,
      );
    });

    it('does not call listeners registered for a different session', () => {
      // Arrange
      const listener = vi.fn();
      bus.onSessionStatus('other-session-id', listener);

      // Act
      bus.emitSessionStatus(TEST_SESSION_ID, TEST_SESSION_STATUS_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling listener after unsubscribe', () => {
      // Arrange
      const listener = vi.fn();
      const unsub = bus.onSessionStatus(TEST_SESSION_ID, listener);
      unsub();

      // Act
      bus.emitSessionStatus(TEST_SESSION_ID, TEST_SESSION_STATUS_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('emitSessionEnd', (it) => {
    it('calls registered listener', () => {
      // Arrange
      const listener = vi.fn();
      bus.onSessionEnd(TEST_SESSION_ID, listener);

      // Act
      bus.emitSessionEnd(TEST_SESSION_ID);

      // Assert
      expect(listener).toHaveBeenCalledOnce();
    });

    it('does not call listeners registered for a different session', () => {
      // Arrange
      const listener = vi.fn();
      bus.onSessionEnd('other-session-id', listener);

      // Act
      bus.emitSessionEnd(TEST_SESSION_ID);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('stops calling listener after unsubscribe', () => {
      // Arrange
      const listener = vi.fn();
      const unsub = bus.onSessionEnd(TEST_SESSION_ID, listener);
      unsub();

      // Act
      bus.emitSessionEnd(TEST_SESSION_ID);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
