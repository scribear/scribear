import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { AudioFrameChannel } from '#src/server/features/transcription-stream/events/audio-frame.events.js';
import { SessionStatusChannel } from '#src/server/features/transcription-stream/events/session-status.events.js';
import { TranscriptChannel } from '#src/server/features/transcription-stream/events/transcript.events.js';
import { TranscriptionStreamService } from '#src/server/features/transcription-stream/transcription-stream.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { SessionTokenService } from '#src/server/shared/services/session-token.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SIGNING_KEY = 'svc-test-key';
const SESSION_UID = '00000000-0000-0000-0000-000000000abc';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function signToken(payload: SessionTokenPayload, key = SIGNING_KEY): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = crypto
    .createHmac('sha256', key)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

interface Harness {
  service: TranscriptionStreamService;
  bus: EventBusService;
  registerSource: ReturnType<typeof vi.fn>;
  unregisterSource: ReturnType<typeof vi.fn>;
  sent: unknown[];
  closes: { code: number; reason: string }[];
}

function makeHarness(
  role: 'source' | 'client',
  options: { authTimeoutMs?: number; registerThrows?: boolean } = {},
): Harness {
  const logger = createMockLogger();
  const bus = new EventBusService(logger as never);
  const tokenService = new SessionTokenService({ signingKey: SIGNING_KEY });
  const unregisterSource = vi.fn();
  const registerSource = vi.fn(async () => {
    if (options.registerThrows) throw new Error('orchestrator-down');
    return unregisterSource;
  });
  const orchestrator = {
    registerSource,
    getStatus: () => ({
      transcriptionServiceConnected: false,
      sourceDeviceConnected: false,
    }),
    activeSessionCount: 0,
  } as unknown as ConstructorParameters<
    typeof TranscriptionStreamService
  >[0]['transcriptionOrchestratorService'];

  const service = new TranscriptionStreamService({
    role,
    urlSessionUid: SESSION_UID,
    logger: logger as never,
    sessionTokenService: tokenService,
    eventBusService: bus,
    transcriptionOrchestratorService: orchestrator,
    authTimeoutMs: options.authTimeoutMs ?? 5000,
  });

  const sent: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  service.on('send', (msg) => {
    sent.push(msg);
  });
  service.on('close', (code, reason) => {
    closes.push({ code, reason });
  });

  return { service, bus, registerSource, unregisterSource, sent, closes };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TranscriptionStreamService', () => {
  describe('auth handshake', (it) => {
    it('emits authOk and registers the source on a valid token with SEND_AUDIO scope', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Assert
      expect(h.registerSource).toHaveBeenCalledWith(SESSION_UID);
      expect(h.sent[0]).toEqual({ type: 'authOk' });
      expect(h.closes).toHaveLength(0);
    });

    it('does not call registerSource for the client role', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Assert
      expect(h.registerSource).not.toHaveBeenCalled();
      expect(h.sent[0]).toEqual({ type: 'authOk' });
    });

    it('closes 1008 invalid-token when the signature is wrong', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken(
        {
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        },
        'wrong-key',
      );

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'invalid-token' });
    });

    it('closes 1008 token-expired when exp is in the past', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'token-expired' });
    });

    it("closes 1008 session-mismatch when the token's sessionUid differs from the URL", async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken({
        sessionUid: '00000000-0000-0000-0000-000000000999',
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'session-mismatch' });
    });

    it('closes 1008 missing-scope when the source role lacks SEND_AUDIO', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'missing-scope' });
    });

    it('closes 1008 missing-scope when the client role lacks RECEIVE_TRANSCRIPTIONS', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'missing-scope' });
    });

    it('closes 1011 orchestrator-unavailable when registerSource throws', async () => {
      // Arrange
      const h = makeHarness('source', { registerThrows: true });
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.closes).toHaveLength(1);
      });

      // Assert
      expect(h.closes[0]).toEqual({
        code: 1011,
        reason: 'orchestrator-unavailable',
      });
    });

    it('closes 1008 auth-timeout when no auth message arrives in time', () => {
      // Arrange
      const h = makeHarness('source', { authTimeoutMs: 100 });

      // Act
      h.service.start();
      vi.advanceTimersByTime(100);

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'auth-timeout' });
    });

    it('does not close on auth-timeout once the client has authed', async () => {
      // Arrange
      const h = makeHarness('source', { authTimeoutMs: 100 });
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      });

      // Act
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });
      vi.advanceTimersByTime(1000);

      // Assert
      expect(h.closes).toHaveLength(0);
    });
  });

  describe('binary frames', (it) => {
    it('publishes binary audio to the bus when the source has authed', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      void h.service.handleAuth(

        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        }),

      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      const received: Buffer[] = [];
      h.bus.subscribe(
        AudioFrameChannel,
        (frame) => {
          received.push(frame);
        },
        SESSION_UID,
      );
      const frame = Buffer.from([1, 2, 3]);

      // Act
      h.service.handleBinary(frame);

      // Assert
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(frame);
    });

    it('closes 1008 when binary arrives before auth completes', () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();

      // Act
      h.service.handleBinary(Buffer.from([1, 2, 3]));

      // Assert
      expect(h.closes[0]).toEqual({ code: 1008, reason: 'binary-before-auth' });
    });

    it('closes 1008 when an authed client connection sends binary', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      void h.service.handleAuth(

        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),

      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act
      h.service.handleBinary(Buffer.from([1]));

      // Assert
      expect(h.closes[0]).toEqual({
        code: 1008,
        reason: 'binary-not-allowed-for-role',
      });
    });
  });

  describe('transcript fan-out', (it) => {
    it('emits transcript send messages when the orchestrator publishes to the bus', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      void h.service.handleAuth(

        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),

      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act - simulate the orchestrator publishing a transcript.
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['hello'], starts: null, ends: null },
          inProgress: null,
        },
        SESSION_UID,
      );

      // Assert
      expect(h.sent.find((m) => (m as { type: string }).type === 'transcript')).toEqual({
        type: 'transcript',
        final: { text: ['hello'], starts: null, ends: null },
        inProgress: null,
      });
    });

    it('does not emit transcripts from a different session', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      void h.service.handleAuth(

        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),

      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['other'], starts: null, ends: null },
          inProgress: null,
        },
        '00000000-0000-0000-0000-000000000999',
      );

      // Assert
      expect(
        h.sent.find((m) => (m as { type: string }).type === 'transcript'),
      ).toBeUndefined();
    });
  });

  describe('cleanup', (it) => {
    it('unregisters from the orchestrator on close', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      void h.service.handleAuth(

        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        }),

      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act
      h.service.handleClose();

      // Assert
      expect(h.unregisterSource).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from the transcript bus on close', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      void h.service.handleAuth(
        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),
      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act
      h.service.handleClose();
      h.bus.publish(
        TranscriptChannel,
        {
          final: { text: ['after-close'], starts: null, ends: null },
          inProgress: null,
        },
        SESSION_UID,
      );

      // Assert - no transcript message was emitted after close.
      expect(
        h.sent.find((m) => (m as { type: string }).type === 'transcript'),
      ).toBeUndefined();
    });

    it('ignores binary frames received after handleClose', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      void h.service.handleAuth(
        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['SEND_AUDIO'],
          exp: FAR_FUTURE,
        }),
      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      const audioReceived: Buffer[] = [];
      h.bus.subscribe(
        AudioFrameChannel,
        (frame) => {
          audioReceived.push(frame);
        },
        SESSION_UID,
      );

      // Act
      h.service.handleClose();
      h.service.handleBinary(Buffer.from([1, 2, 3]));

      // Assert - no audio published, no extra close emitted.
      expect(audioReceived).toHaveLength(0);
      expect(h.closes).toHaveLength(0);
    });
  });

  describe('initial session-status emit', (it) => {
    it("emits the orchestrator's current status snapshot right after authOk", async () => {
      // Arrange - prime the orchestrator stub with a non-default snapshot so
      // the service has something distinguishable to forward.
      const h = makeHarness('client');
      const getStatus = h.service[
        '_transcriptionOrchestratorService'
      ] as unknown as { getStatus: () => unknown };
      vi.spyOn(getStatus, 'getStatus').mockReturnValue({
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      });

      h.service.start();
      void h.service.handleAuth(
        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),
      );

      // Act
      await vi.waitFor(() => {
        expect(
          h.sent.find(
            (m) => (m as { type: string }).type === 'sessionStatus',
          ),
        ).toBeDefined();
      });

      // Assert - authOk first, then sessionStatus carrying the snapshot.
      expect(h.sent[0]).toEqual({ type: 'authOk' });
      expect(h.sent[1]).toEqual({
        type: 'sessionStatus',
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      });
    });

    it('forwards subsequent SessionStatusChannel publishes as sessionStatus messages', async () => {
      // Arrange
      const h = makeHarness('client');
      h.service.start();
      void h.service.handleAuth(
        signToken({
          sessionUid: SESSION_UID,
          clientId: 'c1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),
      );
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });

      // Act
      h.bus.publish(
        SessionStatusChannel,
        {
          transcriptionServiceConnected: true,
          sourceDeviceConnected: true,
        },
        SESSION_UID,
      );

      // Assert
      expect(h.sent).toContainEqual({
        type: 'sessionStatus',
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });
  });

  describe('idempotency', (it) => {
    it('ignores a second handleAuth call once the first succeeded', async () => {
      // Arrange
      const h = makeHarness('source');
      h.service.start();
      const token = signToken({
        sessionUid: SESSION_UID,
        clientId: 'c1',
        scopes: ['SEND_AUDIO'],
        exp: FAR_FUTURE,
      });
      void h.service.handleAuth(token);
      await vi.waitFor(() => {
        expect(h.sent[0]).toEqual({ type: 'authOk' });
      });
      const sentAfterFirst = h.sent.length;

      // Act - the second handleAuth resolves on the next microtask once it
      // hits the `_authed || _authPending` short-circuit, so awaiting it
      // directly is enough to verify nothing extra was emitted.
      await h.service.handleAuth(token);

      // Assert - no additional authOk / no extra register call.
      expect(h.sent.length).toBe(sentAfterFirst);
      expect(h.registerSource).toHaveBeenCalledTimes(1);
    });
  });
});
