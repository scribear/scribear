import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkError } from '@scribear/base-api-client';
import type { MicrophoneService } from '@scribear/microphone-store';
import type { NodeServerClient } from '@scribear/node-server-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import type { Session } from '@scribear/session-manager-schema';

import { KioskService } from '#src/features/kiosk-provider/services/kiosk-service';
import { KioskLifecycle } from '#src/features/kiosk-provider/services/kiosk-service-status';

vi.mock('@scribear/node-server-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/node-server-client')>();
  return {
    ...actual,
    createNodeServerClient: vi.fn(),
  };
});

vi.mock('@scribear/session-manager-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@scribear/session-manager-client')>();
  return {
    ...actual,
    createSessionManagerClient: vi.fn(),
  };
});

/**
 * Minimal stand-in for the transcription-stream `WebSocketClient` - an
 * EventEmitter with the handful of methods `KioskService` calls on it. Real
 * connect/handshake/reconnect behavior lives in `@scribear/base-websocket-client`
 * and is out of scope here; these tests only exercise how `KioskService`
 * reacts once the socket reaches `open`/`close`/`message`/`error`.
 */
function createFakeSocket() {
  const socket = new EventEmitter();
  return Object.assign(socket, {
    start: vi.fn(),
    send: vi.fn(),
    sendBinary: vi.fn(),
    terminate: vi.fn(),
  });
}

/** Minimal stand-in for the `mySchedule` long-poll client. */
function createFakePoll() {
  const poll = new EventEmitter();
  return Object.assign(poll, {
    start: vi.fn(),
    close: vi.fn(),
  });
}

/** Minimal stand-in for `MicrophoneService` - only the two methods a source
 * kiosk calls on it. */
function createFakeMicrophoneService() {
  return {
    getAudioStream: vi.fn().mockResolvedValue({}),
    closeAudioStream: vi.fn(),
  } as unknown as MicrophoneService;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Mint a session token exactly the way session-manager's
 * `SessionTokenService.sign` does: `base64url(payloadJSON)` and a base64url
 * HMAC-SHA256 over that, joined by a `.`. **Two** segments, payload first.
 *
 * Reproducing the real minting is the point: the bug this regression-tests
 * (`decodeJwtExpiryMs`, now `decodeSessionTokenExpiryMs`) read `parts[1]` - a
 * JWT's payload index - and so threw on the raw HMAC signature of every
 * device-issued token this system has ever produced. A hand-written
 * three-segment fixture is exactly what let the equivalent client-webapp bug
 * pass its tests for as long as it did (see `8ff4582`).
 */
async function mintSessionToken(expSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const encodedPayload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        sessionUid: SESSION_UID,
        clientId: 'device-id',
        scopes: ['SEND_AUDIO'],
        exp: expSeconds,
      }),
    ),
  );
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode('test-signing-key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The shape the decoder used to (wrongly) assume: a three-segment JWT. */
function mintJwtShapedToken(expSeconds: number): string {
  const encoder = new TextEncoder();
  const seg = (value: object) =>
    base64UrlEncode(encoder.encode(JSON.stringify(value)));
  return `${seg({ alg: 'HS256' })}.${seg({ exp: expSeconds })}.signature`;
}

const DEVICE_UID = 'device-uid';
const ROOM_UID = 'room-uid';
const SESSION_UID = 'session-uid';
const NOW_MS = 1_800_000_000_000;

function deviceOk(
  overrides: { isSource?: boolean; roomUid?: string | null } = {},
) {
  return [
    {
      status: 200,
      data: {
        uid: DEVICE_UID,
        name: 'Kiosk',
        roomUid: overrides.roomUid === undefined ? ROOM_UID : overrides.roomUid,
        isSource: overrides.isSource ?? false,
      },
    },
    null,
  ];
}

function roomOk() {
  return [
    { status: 200, data: { uid: ROOM_UID, name: 'Room', timezone: 'UTC' } },
    null,
  ];
}

function exchangeOk(sessionToken: string) {
  return [{ status: 200, data: { sessionToken } }, null];
}

/** An ACTIVE session (started in the past, no end) - the shape `_syncSchedule`
 * needs to immediately call `_enterActive`. */
function activeSession(
  overrides: { joinCodeScopes?: string[]; effectiveEnd?: string | null } = {},
): Session {
  return {
    uid: SESSION_UID,
    name: 'Live session',
    effectiveStart: new Date(NOW_MS - 60_000).toISOString(),
    effectiveEnd: overrides.effectiveEnd ?? null,
    joinCodeScopes: overrides.joinCodeScopes ?? [],
  } as unknown as Session;
}

/** An UPCOMING session, `startInMs` from now. */
function upcomingSession(startInMs: number): Session {
  return {
    uid: 'upcoming-session',
    name: 'Upcoming session',
    effectiveStart: new Date(NOW_MS + startInMs).toISOString(),
    effectiveEnd: null,
    joinCodeScopes: [],
  } as unknown as Session;
}

let fakeSocket: ReturnType<typeof createFakeSocket>;
let fakeSourceSocket: ReturnType<typeof createFakeSocket>;
let fakePoll: ReturnType<typeof createFakePoll>;
let getMyDevice: ReturnType<typeof vi.fn>;
let getMyRoom: ReturnType<typeof vi.fn>;
let mySchedule: ReturnType<typeof vi.fn>;
let exchangeDeviceToken: ReturnType<typeof vi.fn>;
let activateDevice: ReturnType<typeof vi.fn>;
let fetchJoinCode: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  // No jitter, so refresh/timer delays are exact fractions rather than +/-10%.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);

  fakeSocket = createFakeSocket();
  fakeSourceSocket = createFakeSocket();
  fakePoll = createFakePoll();
  getMyDevice = vi.fn().mockResolvedValue(deviceOk());
  getMyRoom = vi.fn().mockResolvedValue(roomOk());
  mySchedule = vi.fn(() => fakePoll);
  exchangeDeviceToken = vi.fn();
  activateDevice = vi.fn();
  fetchJoinCode = vi.fn().mockResolvedValue([
    {
      status: 200,
      data: {
        current: { joinCode: 'ABC123', validStart: '', validEnd: '' },
        next: null,
      },
    },
    null,
  ]);

  vi.mocked(createNodeServerClient).mockReturnValue({
    transcriptionStreamClient: vi.fn(() => fakeSocket),
    transcriptionStreamSource: vi.fn(() => fakeSourceSocket),
  } as unknown as NodeServerClient);

  vi.mocked(createSessionManagerClient).mockReturnValue({
    deviceManagement: { getMyDevice, activateDevice },
    roomManagement: { getMyRoom },
    scheduleManagement: { mySchedule },
    sessionAuth: { exchangeDeviceToken, fetchJoinCode },
  } as unknown as SessionManagerClient);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Drive a fresh KioskService from `start()` through IDLE (schedule poll
 * listening, no active session). */
async function bringToIdle(
  microphoneService = createFakeMicrophoneService(),
): Promise<KioskService> {
  const service = new KioskService(microphoneService);
  service.start();
  await vi.advanceTimersByTimeAsync(0);
  return service;
}

/** Drive a fresh KioskService from `start()` through to a live, open socket
 * for the given session (defaults to a non-source display kiosk). */
async function bringSessionActive(
  session: Session = activeSession(),
  microphoneService = createFakeMicrophoneService(),
): Promise<{ service: KioskService; socket: typeof fakeSocket }> {
  const service = await bringToIdle(microphoneService);

  fakePoll.emit('data', {
    serverTime: new Date(NOW_MS).toISOString(),
    sessions: [session],
  });
  await vi.advanceTimersByTimeAsync(0);

  const socket = fakeSocket;
  socket.emit('open');
  await vi.advanceTimersByTimeAsync(0);
  return { service, socket };
}

describe('KioskService session-token refresh (regression: decodeSessionTokenExpiryMs)', () => {
  it('arms a proactive refresh at half the token lifetime and re-AUTHs on the open socket', async () => {
    const first = await mintSessionToken(NOW_MS / 1000 + 600);
    const second = await mintSessionToken(NOW_MS / 1000 + 1200);
    const third = await mintSessionToken(NOW_MS / 1000 + 1800);
    exchangeDeviceToken
      .mockResolvedValueOnce(exchangeOk(first))
      .mockResolvedValueOnce(exchangeOk(second))
      .mockResolvedValueOnce(exchangeOk(third));

    const { socket } = await bringSessionActive();

    // Before the fix, decodeJwtExpiryMs(first) always returned null (it read
    // the raw HMAC signature as parts[1]), so _scheduleTokenRefresh returned
    // early and no refresh was ever armed - this would still be 1 forever.
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(1);

    // Just short of the halfway point (300s): nothing should have fired yet.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenCalledWith({
      type: TranscriptionStreamClientMessageType.AUTH,
      sessionToken: second,
    });

    // And the next refresh is armed off the new token's own lifetime.
    await vi.advanceTimersByTimeAsync(601_000);
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(3);
  });

  it('never refreshes a token whose expiry it cannot read (JWT-shaped, three segments)', async () => {
    const token = mintJwtShapedToken(NOW_MS / 1000 + 600);
    exchangeDeviceToken.mockResolvedValue(exchangeOk(token));

    await bringSessionActive();
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(1);

    // A full 10 minutes with no proactive refresh firing - _scheduleTokenRefresh
    // returns early on an unreadable expiry rather than guessing.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(exchangeDeviceToken).toHaveBeenCalledTimes(1);
  });

  it("reads the real session token's expiry from parts[0], not parts[1]", async () => {
    // A regression-focused counterpart to the two tests above: a real,
    // correctly-shaped token's signature segment (parts[1]) is deliberately
    // NOT valid base64url-encoded JSON, so if the decoder ever regresses back
    // to reading parts[1], this fails with an unreadable-expiry result
    // (no refresh ever fires) instead of a thrown exception.
    const token = await mintSessionToken(NOW_MS / 1000 + 600);
    exchangeDeviceToken.mockResolvedValue(exchangeOk(token));

    await bringSessionActive();
    await vi.advanceTimersByTimeAsync(301_000);

    expect(exchangeDeviceToken).toHaveBeenCalledTimes(2);
  });

  it('falls back to IDLE when a refresh fails, instead of authing with a stale token', async () => {
    const first = await mintSessionToken(NOW_MS / 1000 + 600);
    exchangeDeviceToken
      .mockResolvedValueOnce(exchangeOk(first))
      .mockResolvedValueOnce([null, new NetworkError('offline')]);

    const { service } = await bringSessionActive();
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    await vi.advanceTimersByTimeAsync(301_000);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
  });

  it('falls back to IDLE, without opening a socket, when the initial token fetch fails', async () => {
    exchangeDeviceToken.mockResolvedValue([null, new NetworkError('offline')]);
    const service = await bringToIdle();
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [activeSession()],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(fakeSocket.start).not.toHaveBeenCalled();
    expect(lifecycles).toContain(KioskLifecycle.IDLE);
  });
});

describe('KioskService registration / initialization', () => {
  it('shows UNREGISTERED when getMyDevice answers 401', async () => {
    getMyDevice.mockResolvedValue([{ status: 401, data: null }, null]);
    const service = new KioskService(createFakeMicrophoneService());
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.UNREGISTERED);
    expect(getMyRoom).not.toHaveBeenCalled();
  });

  it('retries on a network error from getMyDevice', async () => {
    getMyDevice
      .mockResolvedValueOnce([null, new NetworkError('offline')])
      .mockResolvedValueOnce(deviceOk());

    const service = new KioskService(createFakeMicrophoneService());
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(getMyDevice).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getMyDevice).toHaveBeenCalledTimes(2);
  });

  it('treats an unassigned device (no room) as IDLE with no schedule poll', async () => {
    getMyDevice.mockResolvedValue(deviceOk({ roomUid: null }));
    const service = new KioskService(createFakeMicrophoneService());
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
    expect(mySchedule).not.toHaveBeenCalled();
  });
});

describe('KioskService activateDevice', () => {
  it('reports a network error without restarting', async () => {
    activateDevice.mockResolvedValue([null, new NetworkError('offline')]);
    const service = new KioskService(createFakeMicrophoneService());
    const errors: (string | null)[] = [];
    service.on('registrationError', (m) => errors.push(m));

    await service.activateDevice('CODE1');

    expect(errors.at(-1)).toMatch(/network error/i);
    expect(getMyDevice).not.toHaveBeenCalled();
  });

  it('restarts initialization on a successful activation', async () => {
    activateDevice.mockResolvedValue([{ status: 200, data: null }, null]);
    const service = new KioskService(createFakeMicrophoneService());

    await service.activateDevice('CODE1');
    await vi.advanceTimersByTimeAsync(0);

    expect(getMyDevice).toHaveBeenCalledTimes(1);
  });

  it('names an expired activation code (410) distinctly from not-found (404)', async () => {
    const service = new KioskService(createFakeMicrophoneService());
    const errors: (string | null)[] = [];
    service.on('registrationError', (m) => errors.push(m));

    activateDevice.mockResolvedValueOnce([{ status: 410, data: null }, null]);
    await service.activateDevice('EXPIRED');
    expect(errors.at(-1)).toMatch(/expired/i);

    activateDevice.mockResolvedValueOnce([{ status: 404, data: null }, null]);
    await service.activateDevice('UNKNOWN');
    expect(errors.at(-1)).toMatch(/not found/i);
  });
});

describe('KioskService mute/unmute', () => {
  it('sends SOURCE_STATE on mute/unmute when a socket is connected', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive(
      activeSession(),
      createFakeMicrophoneService(),
    );

    service.unmute();
    expect(socket.send).toHaveBeenCalledWith({
      type: TranscriptionStreamClientMessageType.SOURCE_STATE,
      microphoneActive: true,
    });

    service.mute();
    expect(socket.send).toHaveBeenCalledWith({
      type: TranscriptionStreamClientMessageType.SOURCE_STATE,
      microphoneActive: false,
    });
  });

  it('is a no-op when no socket is connected yet', async () => {
    const service = await bringToIdle();
    expect(() => {
      service.mute();
    }).not.toThrow();
  });
});

describe('KioskService schedule sync', () => {
  it('schedules a session-start timer for the soonest upcoming session and enters ACTIVE when it fires', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const service = await bringToIdle();
    const active: unknown[] = [];
    service.on('activeSession', (a) => active.push(a));

    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [upcomingSession(30_000)],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(active.filter(Boolean)).toHaveLength(1);
  });

  it('drops back to IDLE when the active session disappears from the schedule', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const service = await bringToIdle();
    const lifecycles: KioskLifecycle[] = [];

    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [activeSession()],
    });
    await vi.advanceTimersByTimeAsync(0);
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
  });
});

describe('KioskService socket close / error handling', () => {
  it('returns to IDLE on a normal 1000 close (session ended)', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    socket.emit('close', 1000, 'session-end', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
  });

  it('returns to IDLE on a 1008 auth failure and lets schedule sync rediscover the session', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const lifecycles: KioskLifecycle[] = [];
    service.on('lifecycleChange', (l) => lifecycles.push(l));

    socket.emit('close', 1008, 'token-expired', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
  });
});

describe('KioskService transcription-stream message handling', () => {
  it('emits transcript and sessionStatus events from server messages', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const transcripts: unknown[] = [];
    const statuses: unknown[] = [];
    service.on('transcript', (t) => transcripts.push(t));
    service.on('sessionStatus', (s) => statuses.push(s));

    socket.emit('message', {
      type: TranscriptionStreamServerMessageType.TRANSCRIPT,
      final: { text: 'hello', startMs: 0, endMs: 100 },
      inProgress: null,
    });
    socket.emit('message', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: true,
    });

    expect(transcripts).toEqual([
      { final: { text: 'hello', startMs: 0, endMs: 100 }, inProgress: null },
    ]);
    expect(statuses).toEqual([
      { transcriptionServiceConnected: true, sourceDeviceConnected: true },
    ]);
  });
});

describe('KioskService source role', () => {
  it('begins audio capture, starts time-sync pings, and seeds mic state on open', async () => {
    const mic = createFakeMicrophoneService();
    getMyDevice.mockResolvedValue(deviceOk({ isSource: true }));
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );

    const service = await bringToIdle(mic);
    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [activeSession()],
    });
    await vi.advanceTimersByTimeAsync(0);

    fakeSourceSocket.emit('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(mic.getAudioStream).toHaveBeenCalledTimes(1);
    expect(fakeSourceSocket.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
      }),
    );
    expect(fakeSourceSocket.send).toHaveBeenCalledWith({
      type: TranscriptionStreamClientMessageType.SOURCE_STATE,
      microphoneActive: false,
    });
    void service;
  });

  it('fetches a join code when the session has non-empty joinCodeScopes', async () => {
    getMyDevice.mockResolvedValue(deviceOk({ isSource: false }));
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );

    await bringSessionActive(
      activeSession({ joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'] }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchJoinCode).toHaveBeenCalledWith({
      body: { sessionUid: SESSION_UID },
    });
  });

  it('does not fetch a join code when joinCodeScopes is empty', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );

    await bringSessionActive(activeSession({ joinCodeScopes: [] }));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchJoinCode).not.toHaveBeenCalled();
  });
});

describe('KioskService stop/teardown', () => {
  it('closes the schedule poll and socket, and returns to INITIALIZING', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service } = await bringSessionActive();

    service.stop();

    expect(fakePoll.close).toHaveBeenCalled();
    expect(fakeSocket.terminate).toHaveBeenCalledWith(1000, 'session-end');
    expect(service.lifecycle).toBe(KioskLifecycle.INITIALIZING);
  });
});
