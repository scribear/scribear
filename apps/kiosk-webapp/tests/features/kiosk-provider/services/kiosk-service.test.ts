import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InvalidResponseBodyError,
  NetworkError,
  UnexpectedResponseError,
} from '@scribear/base-api-client';
import { LongPollResponseError } from '@scribear/base-long-poll-client';
import { SchemaValidationError as WsSchemaValidationError } from '@scribear/base-websocket-client';
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

import type { KioskFault } from '#src/features/kiosk-provider/services/kiosk-service';
import { KioskService } from '#src/features/kiosk-provider/services/kiosk-service';
import {
  KioskLifecycle,
  SessionConnectionStatus,
} from '#src/features/kiosk-provider/services/kiosk-service-status';

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
let transcriptionStreamClient: ReturnType<typeof vi.fn>;
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
  // A fresh poll per call, as the real client does. `_enterIdle` starts a new
  // one on every drop out of a session, and reusing one emitter across those
  // cycles would stack listeners and make the reconnect-loop tests below
  // count each failure several times over.
  mySchedule = vi.fn(() => {
    fakePoll = createFakePoll();
    return fakePoll;
  });
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

  transcriptionStreamClient = vi.fn(() => fakeSocket);
  vi.mocked(createNodeServerClient).mockReturnValue({
    transcriptionStreamClient,
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

/** Deliver a schedule long-poll response on whichever poll is currently live
 * (`_enterIdle` replaces it every time the kiosk drops out of a session). */
async function deliverSchedule(sessions: Session[]): Promise<void> {
  fakePoll.emit('data', {
    serverTime: new Date(NOW_MS).toISOString(),
    sessions,
  });
  await vi.advanceTimersByTimeAsync(0);
}

/** Drive a fresh KioskService from `start()` through to a live, open socket
 * for the given session (defaults to a non-source display kiosk). */
async function bringSessionActive(
  session: Session = activeSession(),
  microphoneService = createFakeMicrophoneService(),
): Promise<{ service: KioskService; socket: typeof fakeSocket }> {
  const service = await bringToIdle(microphoneService);

  await deliverSchedule([session]);

  const socket = fakeSocket;
  socket.emit('open');
  await vi.advanceTimersByTimeAsync(0);
  return { service, socket };
}

/**
 * Record every fault, connection status and lifecycle change a service emits
 * from this point on. Most assertions below are about what the room was
 * *told*, which is precisely what these three streams carry.
 */
function observe(service: KioskService) {
  const faults: (KioskFault | null)[] = [];
  const scheduleFaults: (KioskFault | null)[] = [];
  const statuses: SessionConnectionStatus[] = [];
  const lifecycles: KioskLifecycle[] = [];
  service.on('error', (f) => faults.push(f));
  service.on('scheduleSyncError', (f) => scheduleFaults.push(f));
  service.on('connectionStatus', (s) => statuses.push(s));
  service.on('lifecycleChange', (l) => lifecycles.push(l));
  return { faults, scheduleFaults, statuses, lifecycles };
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

  it('keeps the working socket when a proactive refresh fails, and retries instead of dropping the session', async () => {
    const first = await mintSessionToken(NOW_MS / 1000 + 600);
    exchangeDeviceToken
      .mockResolvedValueOnce(exchangeOk(first))
      .mockResolvedValue([null, new NetworkError('offline')]);

    const { service, socket } = await bringSessionActive();
    const { faults, lifecycles } = observe(service);

    // Halfway through the token's lifetime the proactive refresh fires and
    // fails. The socket is still open and still authenticated on the current
    // token, so tearing the session down (as this used to) would throw away a
    // working connection over a blip.
    await vi.advanceTimersByTimeAsync(301_000);

    expect(lifecycles).not.toContain(KioskLifecycle.IDLE);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(faults.at(-1)).toEqual({
      severity: 'warning',
      message: expect.stringMatching(/cannot reach/i),
    });
  });

  it('goes TERMINAL when the refresh retry budget is exhausted', async () => {
    const first = await mintSessionToken(NOW_MS / 1000 + 600);
    exchangeDeviceToken
      .mockResolvedValueOnce(exchangeOk(first))
      .mockResolvedValue([null, new NetworkError('offline')]);

    const { service } = await bringSessionActive();
    const { faults, statuses } = observe(service);

    // 300 s to the refresh, then 500 + 1000 + 2000 + 4000 ms of backoff
    // across the five allowed attempts.
    await vi.advanceTimersByTimeAsync(301_000 + 7_600);

    expect(statuses.at(-1)).toBe(SessionConnectionStatus.TERMINAL);
    expect(faults.at(-1)?.severity).toBe('error');
    expect(faults.at(-1)?.message).toMatch(/stopped retrying/i);
    // Still ACTIVE: the captions already on the wall stay up and the panel
    // keeps naming the session, rather than claiming the room is idle.
    expect(service.lifecycle).toBe(KioskLifecycle.ACTIVE);
  });

  it('never reports CONNECTED, or opens a socket at all, when the initial token fetch fails', async () => {
    exchangeDeviceToken.mockResolvedValue([null, new NetworkError('offline')]);
    const service = await bringToIdle();
    const { faults, statuses } = observe(service);

    await deliverSchedule([activeSession()]);

    // The handshake used to resolve with no AUTH sent, so the socket reached
    // OPEN, the banner closed, and the room read "connected" with no captions
    // until node-server's auth watchdog closed it five seconds later.
    expect(fakeSocket.start).not.toHaveBeenCalled();
    expect(statuses).not.toContain(SessionConnectionStatus.CONNECTED);
    expect(faults.at(-1)).toEqual({
      severity: 'warning',
      message: 'Cannot reach the ScribeAR session service. Retrying…',
    });
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

  it('returns to IDLE on a single 1008 auth failure and lets schedule sync rediscover the session', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const { lifecycles, statuses } = observe(service);

    // A merely-stale token also closes 1008 and is genuinely fixed by the
    // refetch on the next attempt, so the first one is not terminal.
    socket.emit('close', 1008, 'token-expired', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
  });

  it('goes TERMINAL immediately on a 1008 whose reason can never succeed on a retry', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const { faults, statuses, lifecycles } = observe(service);
    const tokenCallsBefore = exchangeDeviceToken.mock.calls.length;

    socket.emit('close', 1008, 'missing-scope', 1000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(statuses.at(-1)).toBe(SessionConnectionStatus.TERMINAL);
    expect(faults.at(-1)?.severity).toBe('error');
    expect(faults.at(-1)?.message).toMatch(/not permitted to join/i);
    // Nothing keeps trying: no fresh token is fetched, and the kiosk does not
    // bounce through IDLE claiming to be waiting for a session to start.
    expect(exchangeDeviceToken.mock.calls.length).toBe(tokenCallsBefore);
    expect(lifecycles).not.toContain(KioskLifecycle.IDLE);
  });

  it('goes TERMINAL after three 1008 closes whose reason is unfamiliar, counting across reconnects', async () => {
    const session = activeSession();
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive(session);
    const { faults, statuses } = observe(service);

    // Each close drops the kiosk to IDLE, where schedule sync immediately
    // rediscovers the same still-active session and reconnects. A per-socket
    // counter would be refilled by that very loop; this budget is not.
    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([session]);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);

    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([session]);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);

    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses.at(-1)).toBe(SessionConnectionStatus.TERMINAL);
    expect(faults.at(-1)?.message).toMatch(/3 times in a row/);
    expect(service.lifecycle).toBe(KioskLifecycle.ACTIVE);
  });

  it('clears the 1008 budget on AUTH_OK, so an accepted credential resets the count', async () => {
    const session = activeSession();
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive(session);
    const { statuses } = observe(service);

    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([session]);
    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([session]);

    // The server accepts this one - the only proof the credential was good.
    socket.emit('message', {
      type: TranscriptionStreamServerMessageType.AUTH_OK,
    });

    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([session]);
    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
  });

  it('starts a genuinely different session with a full 1008 budget', async () => {
    const first = activeSession();
    const second: Session = { ...activeSession(), uid: 'other-session' };
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive(first);
    const { statuses } = observe(service);

    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deliverSchedule([first]);
    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);

    // A new session is a new credential and a new configuration; the previous
    // session's failures say nothing about it.
    await deliverSchedule([second]);
    socket.emit('close', 1008, '', 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
  });

  it('goes TERMINAL on a schema mismatch rather than silently dropping to IDLE', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive();
    const { faults, statuses, lifecycles } = observe(service);

    socket.emit('error', new WsSchemaValidationError('bad message'));
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses.at(-1)).toBe(SessionConnectionStatus.TERMINAL);
    expect(faults.at(-1)?.message).toMatch(/protocol mismatch/i);
    expect(lifecycles).not.toContain(KioskLifecycle.IDLE);
  });

  it('clears a terminal session once it disappears from the schedule', async () => {
    const session = activeSession();
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service, socket } = await bringSessionActive(session);
    const { faults, lifecycles } = observe(service);

    socket.emit('close', 1008, 'session-mismatch', 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.lifecycle).toBe(KioskLifecycle.ACTIVE);

    // Terminal is scoped to one session: when that session ends, the kiosk
    // goes back to a clean IDLE rather than staying stuck on a stale message.
    await deliverSchedule([]);

    expect(lifecycles).toContain(KioskLifecycle.IDLE);
    expect(faults.at(-1)).toBeNull();
  });
});

describe('KioskService session-token failures (2.4)', () => {
  it('goes TERMINAL immediately, without retrying, when the device is not in the session room', async () => {
    exchangeDeviceToken.mockResolvedValue([
      { status: 403, data: { code: 'DEVICE_NOT_IN_SESSION_ROOM' } },
      null,
    ]);
    const service = await bringToIdle();
    const { faults, statuses } = observe(service);

    await deliverSchedule([activeSession()]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exchangeDeviceToken).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe(SessionConnectionStatus.TERMINAL);
    expect(faults.at(-1)?.message).toMatch(/not assigned to the room/i);
  });

  it('names the HTTP status when the session service refuses with an undeclared one', async () => {
    // 502, not 429: `exchange-device-token` has no rate limiter (see
    // `session-auth.router.ts`), so it can never produce a 429 - the only
    // undeclared statuses that reach this branch are gateway codes like this
    // one (nginx unable to reach session-manager) or a schema mismatch.
    exchangeDeviceToken.mockResolvedValue([
      null,
      new UnexpectedResponseError(502),
    ]);
    const service = await bringToIdle();
    const { faults } = observe(service);

    await deliverSchedule([activeSession()]);

    // 502, 500 and "session-manager is down" used to be one indistinguishable
    // silence.
    expect(faults.at(-1)?.message).toMatch(/HTTP 502/);
    expect(faults.at(-1)?.severity).toBe('warning');
  });

  it('names the service as unreachable, not just an HTTP status, on a non-JSON error body', async () => {
    // A declared status (500) with nothing readable behind it - the fixed
    // `createEndpointClient` bug this whole feature exists to consume. Before
    // this, the promise chain would have escaped the `[response, error]`
    // tuple entirely; now it reports a specific, distinguishable cause.
    exchangeDeviceToken.mockResolvedValue([
      null,
      new InvalidResponseBodyError(500, new SyntaxError('boom')),
    ]);
    const service = await bringToIdle();
    const { faults } = observe(service);

    await deliverSchedule([activeSession()]);

    expect(faults.at(-1)?.message).toMatch(/unreachable/i);
    expect(faults.at(-1)?.message).toMatch(/HTTP 500/);
    expect(faults.at(-1)?.severity).toBe('warning');
  });

  it('rejects the handshake, rather than reporting OPEN, when no token is available', async () => {
    exchangeDeviceToken.mockResolvedValue(
      exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
    );
    const { service } = await bringSessionActive();
    const options = transcriptionStreamClient.mock.calls[0]?.[1] as {
      onHandshake: (sender: unknown, messages: unknown) => Promise<void>;
    };

    // Teardown drops the token. A reconnect that ran the handshake anyway
    // used to *return*, resolving it without sending AUTH - so the client
    // reported OPEN and the banner closed with nothing authenticated.
    service.stop();
    const sender = { send: vi.fn(), sendBinary: vi.fn() };

    await expect(
      options.onHandshake(sender, new EventEmitter()),
    ).rejects.toThrow(/session token/i);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('abandons an in-flight token fetch when a newer session takes over', async () => {
    const token = await mintSessionToken(NOW_MS / 1000 + 600);
    // One slow, shared in-flight response, so both sessions' fetches are
    // still pending when the second one takes over.
    const pending = new Promise((resolve) => {
      setTimeout(() => {
        resolve(exchangeOk(token));
      }, 1_000);
    });
    exchangeDeviceToken.mockReturnValue(pending);
    const service = await bringToIdle();
    const other: Session = { ...activeSession(), uid: 'other-session' };

    // Both fetches are in flight at once; only the newer session may act on
    // its result, or the superseded one leaks a second socket over it.
    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [activeSession()],
    });
    fakePoll.emit('data', {
      serverTime: new Date(NOW_MS).toISOString(),
      sessions: [other],
    });
    await vi.advanceTimersByTimeAsync(1_100);

    expect(fakeSocket.start).toHaveBeenCalledTimes(1);
    expect(service.lifecycle).toBe(KioskLifecycle.ACTIVE);
  });

  it('abandons a backing-off retry when a newer session takes over', async () => {
    exchangeDeviceToken.mockResolvedValue([null, new NetworkError('offline')]);
    const service = await bringToIdle();
    const { statuses } = observe(service);
    const other: Session = { ...activeSession(), uid: 'other-session' };

    await deliverSchedule([activeSession()]);
    await deliverSchedule([other]);
    await vi.advanceTimersByTimeAsync(60_000);

    // Exactly one terminal declaration: the abandoned loop woke from its
    // backoff, saw it had been superseded, and stopped without spending the
    // new session's budget or announcing a failure that no longer applies.
    expect(
      statuses.filter((s) => s === SessionConnectionStatus.TERMINAL),
    ).toHaveLength(1);
  });

  it('recovers, connects and clears the fault when a transient failure stops', async () => {
    exchangeDeviceToken
      .mockResolvedValueOnce([null, new NetworkError('offline')])
      .mockResolvedValue(
        exchangeOk(await mintSessionToken(NOW_MS / 1000 + 600)),
      );
    const service = await bringToIdle();
    const { faults, statuses } = observe(service);

    await deliverSchedule([activeSession()]);
    expect(faults.at(-1)?.severity).toBe('warning');

    await vi.advanceTimersByTimeAsync(600);
    fakeSocket.emit('open');
    fakeSocket.emit('stateChange', 'OPEN');
    await vi.advanceTimersByTimeAsync(0);

    expect(fakeSocket.start).toHaveBeenCalled();
    expect(faults.at(-1)).toBeNull();
    expect(statuses.at(-1)).toBe(SessionConnectionStatus.CONNECTED);
  });
});

describe('KioskService schedule long-poll health (2.5)', () => {
  it('says nothing about a single transient poll failure', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    fakePoll.emit('error', new NetworkError('offline'));
    fakePoll.emit('error', new NetworkError('offline'));
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduleFaults).toEqual([]);
  });

  it('reports a sustained schedule-sync outage, naming the cause and the consequence', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    for (let i = 0; i < 3; i++) {
      fakePoll.emit('error', new NetworkError('offline'));
    }
    await vi.advanceTimersByTimeAsync(0);

    // The whole point: this used to be `poll.on('error', () => {})`, so
    // schedule sync could be dead for hours behind "Inactive, waiting for a
    // session to start." - the same sentence a healthy kiosk shows.
    expect(scheduleFaults.at(-1)).toEqual({
      severity: 'warning',
      message:
        'Cannot reach the ScribeAR schedule service. Scheduled sessions may not start or end on time on this kiosk.',
    });
  });

  it('distinguishes a failing schedule service from an unreachable one', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    for (let i = 0; i < 3; i++) {
      fakePoll.emit('error', new UnexpectedResponseError(500));
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduleFaults.at(-1)?.message).toMatch(/HTTP 500/);
  });

  it('names a revoked device token rather than blaming the schedule service', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    // A declared 401 used to reach `poll.on('data')` as if it were the
    // schedule payload, because `createEndpointClient` returns declared
    // statuses in the response slot. Nothing was said, and `payload.sessions`
    // was `undefined`.
    for (let i = 0; i < 3; i++) {
      fakePoll.emit(
        'error',
        new LongPollResponseError(401, {
          code: 'INVALID_DEVICE_TOKEN',
          message: 'The DEVICE_TOKEN cookie is missing, expired, or revoked.',
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduleFaults.at(-1)?.message).toMatch(/Re-activate the device/);
    expect(scheduleFaults.at(-1)?.message).not.toMatch(/HTTP 401/);
  });

  it('names an unassigned device on a 404 rather than blaming the schedule service', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    for (let i = 0; i < 3; i++) {
      fakePoll.emit(
        'error',
        new LongPollResponseError(404, {
          code: 'DEVICE_NOT_IN_ROOM',
          message: 'Device is not assigned to a room.',
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduleFaults.at(-1)?.message).toMatch(/not assigned to a room/);
  });

  it('falls back to the HTTP-status wording for a declared 500', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    // `LongPollResponseError` extends `UnexpectedResponseError`, so a status
    // with no device-specific meaning keeps the pre-existing wording.
    for (let i = 0; i < 3; i++) {
      fakePoll.emit(
        'error',
        new LongPollResponseError(500, {
          code: 'INTERNAL_ERROR',
          message: 'boom',
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduleFaults.at(-1)?.message).toMatch(/HTTP 500/);
  });

  it('clears the schedule-sync fault as soon as a response arrives', async () => {
    const service = await bringToIdle();
    const { scheduleFaults } = observe(service);

    for (let i = 0; i < 3; i++) {
      fakePoll.emit('error', new NetworkError('offline'));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduleFaults.at(-1)).not.toBeNull();

    await deliverSchedule([]);

    expect(scheduleFaults.at(-1)).toBeNull();
  });
});

describe('KioskService device-info failures (2.2)', () => {
  it('reports an unreachable server while it retries initialization', async () => {
    getMyDevice.mockResolvedValue([null, new NetworkError('offline')]);
    const service = new KioskService(createFakeMicrophoneService());
    const { faults } = observe(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(faults.at(-1)).toEqual({
      severity: 'warning',
      message: 'Cannot reach the ScribeAR server. Retrying…',
    });
  });

  it('names the HTTP status when device info is refused, and clears it on recovery', async () => {
    getMyDevice
      .mockResolvedValueOnce([null, new UnexpectedResponseError(500)])
      .mockResolvedValue(deviceOk());
    const service = new KioskService(createFakeMicrophoneService());
    const { faults } = observe(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(faults.at(-1)?.message).toMatch(/HTTP 500/);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(faults.at(-1)).toBeNull();
  });

  it('says nothing extra when the device is simply unregistered', async () => {
    getMyDevice.mockResolvedValue([{ status: 401, data: null }, null]);
    const service = new KioskService(createFakeMicrophoneService());
    const { faults } = observe(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    // The activation form this drops to is itself the explanation; a banner
    // on top of it would be noise, not information.
    expect(faults.filter(Boolean)).toEqual([]);
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
