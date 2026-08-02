import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkError } from '@scribear/base-api-client';
import type { NodeServerClient } from '@scribear/node-server-client';
import { createNodeServerClient } from '@scribear/node-server-client';
import {
  TranscriptionServiceDisconnectReason,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import { createSessionManagerClient } from '@scribear/session-manager-client';

import { ClientSessionService } from '#src/features/session-provider/services/client-session-service';
import type {
  SessionIdentity,
  SessionStatusSnapshot,
} from '#src/features/session-provider/services/client-session-service';
import {
  ClientLifecycle,
  JoinError,
  JoinNotice,
  SessionConnectionStatus,
} from '#src/features/session-provider/services/client-session-service-status';

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
 * Minimal stand-in for `WebSocketClient` - an EventEmitter with the handful
 * of methods `ClientSessionService` calls on it. Real connect/reconnect
 * behavior lives in `@scribear/base-websocket-client` and is out of scope
 * here; this test only exercises how `ClientSessionService` reacts to
 * messages/close codes it receives.
 */
function createFakeSocket() {
  const socket = new EventEmitter();
  return Object.assign(socket, {
    start: vi.fn(),
    send: vi.fn(),
    terminate: vi.fn(),
  });
}

const IDENTITY: SessionIdentity = {
  sessionUid: 'session-uid',
  sessionRefreshToken: 'refresh-token',
  clientId: 'client-id',
};

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
 * Reproducing the real minting is the point. The expiry decoder read
 * `parts[1]` - a JWT's payload index - and so threw on the signature of every
 * token this system has ever issued; a hand-written three-segment fixture is
 * what let that pass its tests for as long as it did.
 */
async function mintSessionToken(expSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const encodedPayload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        sessionUid: IDENTITY.sessionUid,
        clientId: IDENTITY.clientId,
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
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

/** The shape the decoder used to assume: a three-segment JWT. */
function mintJwtShapedToken(expSeconds: number): string {
  const encoder = new TextEncoder();
  const seg = (value: object) =>
    base64UrlEncode(encoder.encode(JSON.stringify(value)));
  return `${seg({ alg: 'HS256' })}.${seg({ exp: expSeconds })}.signature`;
}

let fakeSocket: ReturnType<typeof createFakeSocket>;
let exchangeJoinCode: ReturnType<typeof vi.fn>;
let refreshSessionToken: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeSocket = createFakeSocket();
  exchangeJoinCode = vi.fn();
  refreshSessionToken = vi.fn();
  vi.mocked(createNodeServerClient).mockReturnValue({
    transcriptionStreamClient: vi.fn(() => fakeSocket),
    transcriptionStreamSource: vi.fn(() => createFakeSocket()),
  } as unknown as NodeServerClient);
  vi.mocked(createSessionManagerClient).mockReturnValue({
    sessionAuth: { exchangeJoinCode, refreshSessionToken },
  } as unknown as SessionManagerClient);
});

/** Response tuple for a successful `refreshSessionToken`. */
function refreshOk(sessionToken: string) {
  return [{ status: 200, data: { sessionToken } }, null];
}

/** Response tuple for a successful `exchangeJoinCode`. */
function joinOk(sessionToken: string) {
  return [
    {
      status: 200,
      data: {
        sessionUid: IDENTITY.sessionUid,
        sessionRefreshToken: IDENTITY.sessionRefreshToken,
        clientId: IDENTITY.clientId,
        sessionToken,
      },
    },
    null,
  ];
}

/** Session tokens presented in AUTH messages, in order. */
function authenticatedTokens(): string[] {
  return fakeSocket.send.mock.calls
    .map(
      ([msg]) =>
        msg as {
          type: TranscriptionStreamClientMessageType;
          sessionToken: string;
        },
    )
    .filter((msg) => msg.type === TranscriptionStreamClientMessageType.AUTH)
    .map((msg) => msg.sessionToken);
}

describe('ClientSessionService SESSION_STATUS handling', () => {
  it('passes transcriptionServiceDisconnectReason through when the server includes it', () => {
    const service = new ClientSessionService();
    const statuses: SessionStatusSnapshot[] = [];
    service.on('sessionStatus', (status) => statuses.push(status));

    service.start(IDENTITY);

    fakeSocket.emit('message', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });

    expect(statuses).toEqual([
      {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: true,
        transcriptionServiceDisconnectReason:
          TranscriptionServiceDisconnectReason.AT_CAPACITY,
      },
    ]);
  });

  it('leaves transcriptionServiceDisconnectReason undefined when the server omits it', () => {
    const service = new ClientSessionService();
    const statuses: SessionStatusSnapshot[] = [];
    service.on('sessionStatus', (status) => statuses.push(status));

    service.start(IDENTITY);

    fakeSocket.emit('message', {
      type: TranscriptionStreamServerMessageType.SESSION_STATUS,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: true,
    });

    expect(statuses).toEqual([
      {
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      },
    ]);
    expect(statuses[0]).not.toHaveProperty(
      'transcriptionServiceDisconnectReason',
    );
  });
});

describe('ClientSessionService session-token expiry', () => {
  const NOW_MS = 1_800_000_000_000;

  beforeEach(() => {
    // Fixed clock, and no jitter, so the refresh delay is exactly half the
    // remaining lifetime rather than half ±10%.
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends AUTH with the token from joinSession without spending a refresh on it', async () => {
    const token = await mintSessionToken(NOW_MS / 1000 + 600);
    exchangeJoinCode.mockResolvedValue(joinOk(token));
    const service = new ClientSessionService();

    await service.joinSession('JOINCODE');
    fakeSocket.emit('open');

    // The token is valid for ten more minutes; treating it as expired (which
    // an unreadable `exp` does) burns a refresh round-trip on every single
    // socket open, and leaves AUTH unsent entirely if that call fails.
    expect(refreshSessionToken).not.toHaveBeenCalled();
    expect(authenticatedTokens()).toEqual([token]);
  });

  it('treats a token whose expiry it cannot read as expired', async () => {
    // A three-segment JWT is not the format this system issues; refusing to
    // read an `exp` out of one is the conservative direction.
    exchangeJoinCode.mockResolvedValue(
      joinOk(mintJwtShapedToken(NOW_MS / 1000 + 600)),
    );
    const refreshed = await mintSessionToken(NOW_MS / 1000 + 600);
    refreshSessionToken.mockResolvedValue(refreshOk(refreshed));
    const service = new ClientSessionService();

    await service.joinSession('JOINCODE');
    fakeSocket.emit('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshSessionToken).toHaveBeenCalledTimes(1);
    expect(authenticatedTokens()).toEqual([refreshed]);
  });

  it('arms a proactive refresh at half the token lifetime and re-AUTHs in place', async () => {
    const first = await mintSessionToken(NOW_MS / 1000 + 600);
    const second = await mintSessionToken(NOW_MS / 1000 + 1200);
    exchangeJoinCode.mockResolvedValue(joinOk(first));
    refreshSessionToken.mockResolvedValue(refreshOk(second));
    const service = new ClientSessionService();

    await service.joinSession('JOINCODE');
    fakeSocket.emit('open');

    // Just short of the halfway point: nothing should have fired yet.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(refreshSessionToken).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshSessionToken).toHaveBeenCalledTimes(1);
    // Re-AUTH on the *existing* socket - the connection is never dropped to
    // pick up a new token.
    expect(authenticatedTokens()).toEqual([first, second]);
    expect(fakeSocket.terminate).not.toHaveBeenCalled();

    // And the next one is armed off the new token's own lifetime.
    await vi.advanceTimersByTimeAsync(601_000);
    expect(refreshSessionToken).toHaveBeenCalledTimes(2);
  });
});

describe('ClientSessionService terminal states', () => {
  function trackTerminal(service: ClientSessionService) {
    const statuses: SessionConnectionStatus[] = [];
    const errors: (string | null)[] = [];
    service.on('connectionStatus', (status) => statuses.push(status));
    service.on('error', (message) => errors.push(message));
    return { statuses, errors };
  }

  it('gives up immediately on a 1008 close whose reason can never succeed', () => {
    const service = new ClientSessionService();
    const { statuses, errors } = trackTerminal(service);

    service.start(IDENTITY);
    fakeSocket.emit('close', 1008, 'missing-scope', 1000);

    expect(statuses).toContain(SessionConnectionStatus.TERMINAL);
    expect(errors.at(-1)).toMatch(/refused the connection/);
  });

  it('tolerates a couple of unexplained 1008 closes, then gives up', () => {
    const service = new ClientSessionService();
    const { statuses } = trackTerminal(service);

    service.start(IDENTITY);
    // `auth-timeout` is what node-server sends when AUTH never arrived - by
    // itself recoverable, which is why it is not on the permanent list. What
    // is not recoverable is it happening every single time: without a bound
    // this is the ~1 s hammer loop, invisible behind "Reconnecting…".
    fakeSocket.emit('close', 1008, 'auth-timeout', 1000);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
    fakeSocket.emit('close', 1008, 'auth-timeout', 1000);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
    fakeSocket.emit('close', 1008, 'auth-timeout', 1000);

    expect(statuses).toContain(SessionConnectionStatus.TERMINAL);
  });

  it('does not give up when the 1008s are interrupted by a successful auth', () => {
    const service = new ClientSessionService();
    const { statuses } = trackTerminal(service);

    service.start(IDENTITY);
    fakeSocket.emit('close', 1008, 'token-expired', 1000);
    fakeSocket.emit('close', 1008, 'token-expired', 1000);
    fakeSocket.emit('message', {
      type: TranscriptionStreamServerMessageType.AUTH_OK,
    });
    fakeSocket.emit('close', 1008, 'token-expired', 1000);
    fakeSocket.emit('close', 1008, 'token-expired', 1000);

    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
  });

  it('gives up once the refresh retry budget is exhausted, and says so', async () => {
    vi.useFakeTimers();
    refreshSessionToken.mockResolvedValue([null, new NetworkError('offline')]);
    const service = new ClientSessionService();
    const { statuses, errors } = trackTerminal(service);

    service.start(IDENTITY);
    fakeSocket.emit('open');
    // Backoff between attempts is 300/600/1200/2400ms, so a few seconds
    // covers the whole budget however the jitter falls.
    await vi.advanceTimersByTimeAsync(30_000);

    // Bounded: it stops asking, rather than reconnecting into the same failed
    // refresh forever.
    expect(refreshSessionToken).toHaveBeenCalledTimes(5);
    expect(statuses).toContain(SessionConnectionStatus.TERMINAL);
    expect(errors.at(-1)).toMatch(/could not restore it/i);
    expect(fakeSocket.send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('recovers without going terminal when the refresh eventually succeeds', async () => {
    vi.useFakeTimers();
    const token = await mintSessionToken(Date.now() / 1000 + 600);
    refreshSessionToken
      .mockResolvedValueOnce([null, new NetworkError('offline')])
      .mockResolvedValueOnce([null, new NetworkError('offline')])
      .mockResolvedValue(refreshOk(token));
    const service = new ClientSessionService();
    const { statuses } = trackTerminal(service);

    service.start(IDENTITY);
    fakeSocket.emit('open');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshSessionToken).toHaveBeenCalledTimes(3);
    expect(statuses).not.toContain(SessionConnectionStatus.TERMINAL);
    expect(authenticatedTokens()).toEqual([token]);
    vi.useRealTimers();
  });
});

describe('ClientSessionService normal session end', () => {
  function trackEnd(service: ClientSessionService) {
    const notices: (JoinNotice | null)[] = [];
    const lifecycles: ClientLifecycle[] = [];
    service.on('joinNotice', (notice) => notices.push(notice));
    service.on('lifecycleChange', (lifecycle) => lifecycles.push(lifecycle));
    return { notices, lifecycles };
  }

  it('tells the user the session ended when the socket closes 1000', () => {
    const service = new ClientSessionService();
    const { notices, lifecycles } = trackEnd(service);

    service.start(IDENTITY);
    fakeSocket.emit('close', 1000, '', 1000);

    // The join dialog is about to reopen over a suddenly-empty caption pane.
    // Without this it reopened blank, and a session ending exactly as
    // intended was indistinguishable from the app breaking.
    expect(notices).toEqual([JoinNotice.SESSION_ENDED]);
    expect(lifecycles.at(-1)).toBe(ClientLifecycle.IDLE);
  });

  it('emits the notice before dropping to IDLE, so the dialog is never blank', () => {
    const service = new ClientSessionService();
    const order: string[] = [];
    service.on('joinNotice', () => order.push('notice'));
    service.on('lifecycleChange', (lifecycle) => {
      if (lifecycle === ClientLifecycle.IDLE) order.push('idle');
    });

    service.start(IDENTITY);
    fakeSocket.emit('close', 1000, '', 1000);

    expect(order).toEqual(['notice', 'idle']);
  });

  it('says nothing when the user leaves the session themselves', () => {
    const service = new ClientSessionService();
    const { notices, lifecycles } = trackEnd(service);

    service.start(IDENTITY);
    service.leaveSession();

    // The user pressed Leave; "This session has ended." would be a lie about
    // who ended it. The explicit `null` also clears any earlier notice.
    expect(notices).toEqual([null]);
    expect(lifecycles.at(-1)).toBe(ClientLifecycle.IDLE);
  });

  it('does not claim the session ended for any other close code', () => {
    const service = new ClientSessionService();
    const { notices } = trackEnd(service);

    service.start(IDENTITY);
    // Abnormal (1006), server error (1011), restarting (1012) and auth
    // (1008) all keep their existing behaviour: the transport retries, and
    // the connection banner - not the join dialog - does the explaining.
    fakeSocket.emit('close', 1006, '', 1000);
    fakeSocket.emit('close', 1011, '', 1000);
    fakeSocket.emit('close', 1012, '', 1000);
    fakeSocket.emit('close', 1008, 'token-expired', 1000);

    expect(notices).toEqual([]);
  });

  it('does not claim the session ended when a 1008 turns terminal', () => {
    const service = new ClientSessionService();
    const { notices } = trackEnd(service);

    service.start(IDENTITY);
    fakeSocket.emit('close', 1008, 'missing-scope', 1000);

    // Terminal states explain themselves through `error` and the banner's
    // terminal branch; the session did not "end", the client gave up on it.
    expect(notices).toEqual([]);
  });

  it('clears the notice as soon as the user submits another join code', async () => {
    exchangeJoinCode.mockResolvedValue(joinOk('payload.signature'));
    const service = new ClientSessionService();
    const { notices } = trackEnd(service);

    service.start(IDENTITY);
    fakeSocket.emit('close', 1000, '', 1000);
    await service.joinSession('JOINCODE');

    expect(notices).toEqual([JoinNotice.SESSION_ENDED, null]);
  });

  it('reports a 409 SESSION_ENDED refresh the same way as the 1000 close', async () => {
    refreshSessionToken.mockResolvedValue([
      { status: 409, data: { code: 'SESSION_ENDED' } },
      null,
    ]);
    const service = new ClientSessionService();
    const { notices } = trackEnd(service);

    service.start(IDENTITY);
    fakeSocket.emit('open');

    // Same event as the 1000 close, learned over the other channel - which of
    // the two noticed first must not decide whether the user is told.
    await vi.waitFor(() => {
      expect(notices).toEqual([JoinNotice.SESSION_ENDED]);
    });
  });

  it('stays silent on a 401 refresh, which is not the session ending', async () => {
    refreshSessionToken.mockResolvedValue([
      { status: 401, data: { code: 'INVALID_REFRESH_TOKEN' } },
      null,
    ]);
    const service = new ClientSessionService();
    const { notices, lifecycles } = trackEnd(service);

    service.start(IDENTITY);
    fakeSocket.emit('open');

    await vi.waitFor(() => {
      expect(lifecycles.at(-1)).toBe(ClientLifecycle.IDLE);
    });
    expect(notices).toEqual([null]);
  });
});

describe('ClientSessionService resume after reload', () => {
  it('re-announces the stored identity so the reloaded page has a session', () => {
    const service = new ClientSessionService();
    const identities: (SessionIdentity | null)[] = [];
    service.on('sessionIdentity', (identity) => identities.push(identity));

    service.start(IDENTITY);

    // Without this the middleware never dispatches `setActiveSession`, so
    // `clientSessionService.session` stays null, every `setConnectionStatus`
    // early-returns, and the reloaded viewer sees no banner at all - even
    // with a dead socket.
    expect(identities).toEqual([IDENTITY]);
  });

  it('does not announce an identity when there is nothing stored', () => {
    const service = new ClientSessionService();
    const identities: (SessionIdentity | null)[] = [];
    service.on('sessionIdentity', (identity) => identities.push(identity));

    service.start(null);

    expect(identities).toEqual([]);
  });
});

describe('ClientSessionService rate limiting', () => {
  /** Response tuple for a 429 from either credential-exchange route. */
  function rateLimited() {
    return [
      {
        status: 429,
        data: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please retry shortly.',
        },
      },
      null,
    ];
  }

  it('gives a rate-limited join its own error rather than UNKNOWN', async () => {
    exchangeJoinCode.mockResolvedValue(rateLimited());
    const service = new ClientSessionService();
    const joinErrors: (JoinError | null)[] = [];
    service.on('joinError', (error) => joinErrors.push(error));

    await service.joinSession('JOINCODE');

    // A lecture hall behind one campus NAT shares a client IP and trips the
    // limit collectively. Collapsed into UNKNOWN this read "Unable to join
    // session. Please try again." - an instruction the whole room follows at
    // once, producing the next round of 429s.
    expect(joinErrors).toEqual([null, JoinError.RATE_LIMITED]);
    expect(service.lifecycle).toBe(ClientLifecycle.IDLE);
  });

  it('still reports a genuinely unexpected join status as UNKNOWN', async () => {
    exchangeJoinCode.mockResolvedValue([
      { status: 500, data: { code: 'INTERNAL_ERROR', message: 'boom' } },
      null,
    ]);
    const service = new ClientSessionService();
    const joinErrors: (JoinError | null)[] = [];
    service.on('joinError', (error) => joinErrors.push(error));

    await service.joinSession('JOINCODE');

    expect(joinErrors).toEqual([null, JoinError.UNKNOWN]);
  });

  it('does not tell a rate-limited viewer to fetch a new join code', async () => {
    vi.useFakeTimers();
    refreshSessionToken.mockResolvedValue(rateLimited());
    const service = new ClientSessionService();
    const errors: (string | null)[] = [];
    service.on('error', (message) => errors.push(message));

    service.start(IDENTITY);
    fakeSocket.emit('open');
    await vi.advanceTimersByTimeAsync(30_000);

    // Still bounded - 429 is charged to the same budget as any other
    // transient failure, so the loop converges rather than hammering a server
    // that is already asking it to stop.
    expect(refreshSessionToken).toHaveBeenCalledTimes(5);
    const terminal = errors.at(-1) ?? '';
    // The load-bearing assertion: a new join code is exchanged over a
    // rate-limited route too, so the old wording ("join again with a new join
    // code") sent the user to reproduce the failure. The new wording may
    // mention join codes, but only to rule them out.
    expect(terminal).not.toMatch(/join again with a new join code/i);
    expect(terminal).toMatch(/you do not need a new join code/i);
    expect(terminal).toMatch(/too many people are reconnecting/i);
    vi.useRealTimers();
  });

  it('keeps the generic terminal wording when the last failure was not a rate limit', async () => {
    vi.useFakeTimers();
    refreshSessionToken
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValue([null, new NetworkError('offline')]);
    const service = new ClientSessionService();
    const errors: (string | null)[] = [];
    service.on('error', (message) => errors.push(message));

    service.start(IDENTITY);
    fakeSocket.emit('open');
    await vi.advanceTimersByTimeAsync(30_000);

    // The flag describes the most recent failure, not "a 429 happened once":
    // a session that started rate-limited and ended up genuinely offline must
    // not be told to wait for a limit window that is no longer the problem.
    expect(errors.at(-1)).toMatch(/could not restore it/i);
    vi.useRealTimers();
  });
});
