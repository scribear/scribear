import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import type { TestAudioDeviceState } from '#src/server/features/test-audio/test-audio.schema.js';
import { SessionService } from '#src/server/shared/services/session.service.js';
import { ROLE_READ_ONLY } from '#src/server/shared/types/identity.js';
import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import {
  TEST_AUDIO_BASE_URL,
  TEST_AUDIO_SERVICE_KEY,
  login,
  useServer,
} from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1/test-audio';
const UPSTREAM_DEVICES_URL = `${TEST_AUDIO_BASE_URL}/api/test-audio/v1/devices`;

/**
 * The three mutations, so the guard suites assert against every one of them
 * rather than against a representative. A route that quietly forgets `csrfHook`
 * is exactly the kind of thing a representative test misses.
 */
const MUTATIONS = [
  {
    name: 'start',
    method: 'POST' as const,
    url: `${BASE}/good/start`,
    payload: { durationSec: 60, params: { gainDb: -6 } },
  },
  {
    name: 'stop',
    method: 'POST' as const,
    url: `${BASE}/good/stop`,
    payload: {},
  },
  {
    name: 'params',
    method: 'PATCH' as const,
    url: `${BASE}/good/params`,
    payload: { gainDb: -12 },
  },
];

const IDLE_GOOD: TestAudioDeviceState = {
  deviceId: 'good',
  configured: true,
  state: 'idle',
  params: { clip: 'harvard', gainDb: 0, noiseType: 'none', noiseDb: -60 },
  sessionUid: null,
  roomName: 'TEST-AUDIO-GOOD',
  startedAtMs: null,
  expiresAtMs: null,
  framesSent: 0,
  framesFaulted: 0,
  transcriptCount: 0,
  lastTranscript: null,
  error: null,
};

const STREAMING_GOOD: TestAudioDeviceState = {
  ...IDLE_GOOD,
  state: 'streaming',
  sessionUid: '11111111-1111-1111-1111-111111111111',
  startedAtMs: 1_700_000_000_000,
  expiresAtMs: 1_700_000_060_000,
};

interface ErrorBody {
  ok: boolean;
  error: { code: string; message: string; requestId: string };
}

/**
 * Demote whatever session the following requests present to `read-only`.
 *
 * `LocalAuthService` only ever mints `read-write`, so there is no login that
 * produces a read-only identity; the role is a seam for a future SSO group
 * mapping. Wrapping `validate` is the smallest way to drive the route guard
 * that mapping will one day flow through — and the guard, not the provider, is
 * what these routes depend on.
 */
function useReadOnlyIdentity() {
  const original = SessionService.prototype.validate;
  return vi
    .spyOn(SessionService.prototype, 'validate')
    .mockImplementation(function (this: SessionService, sessionId?: string) {
      const record = original.call(this, sessionId);
      if (!record) return null;
      // A copy, not a mutation: the real record outlives the spy.
      return {
        ...record,
        identity: { ...record.identity, roles: [ROLE_READ_ONLY] },
      };
    });
}

describe('Test audio routes, feature unconfigured (default: TEST_AUDIO_BASE_URL unset)', () => {
  const server = useServer();
  const dbCtx = useDb();
  let sm: SessionManagerMock;
  let cookie = '';
  let csrfToken = '';

  // Logged in ONCE per suite, not per test: `ADMIN_RATE_LIMIT_LOGIN_MAX` is 5
  // per minute and applies in tests too, so a per-test login turns the sixth
  // test in a suite into a silent 429 and every assertion after it into a 401.
  beforeAll(async () => {
    ({ cookie, csrfToken } = await login(server.fastify));
  });

  // The same global-`fetch` interceptor the Session Manager suites use — the
  // mechanism is generic, and here it exists mostly to PROVE no upstream call
  // was made.
  beforeEach(() => {
    sm = new SessionManagerMock();
  });
  afterEach(() => {
    sm.restore();
  });

  describe('auth guard', (it) => {
    it('rejects an unauthenticated read with 401', async () => {
      // Act
      const res = await server.fastify.inject({ method: 'GET', url: BASE });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorBody>().error.code).toBe('UNAUTHENTICATED');
    });

    for (const mutation of MUTATIONS) {
      it(`rejects an unauthenticated ${mutation.name} with 401`, async () => {
        // Act
        const res = await server.fastify.inject({
          method: mutation.method,
          url: mutation.url,
          payload: mutation.payload,
        });

        // Assert
        expect(res.statusCode).toBe(401);
        expect(res.json<ErrorBody>().error.code).toBe('UNAUTHENTICATED');
      });
    }
  });

  describe('availability', (it) => {
    it('answers the read 200 with an empty, unavailable panel — not an error', async () => {
      // Act — a deployment that never provisioned the devices is not broken,
      // so the SPA must be able to render a disabled panel.
      const res = await server.fastify.inject({
        method: 'GET',
        url: BASE,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { available: false, devices: [] },
      });
      expect(sm.requests.length).toBe(0);
    });

    for (const mutation of MUTATIONS) {
      it(`answers ${mutation.name} with 503 TEST_AUDIO_UNAVAILABLE and no audit row`, async () => {
        // Act
        const res = await server.fastify.inject({
          method: mutation.method,
          url: mutation.url,
          headers: { cookie, 'x-csrf-token': csrfToken },
          payload: mutation.payload,
        });

        // Assert
        expect(res.statusCode).toBe(503);
        expect(res.json<ErrorBody>().error.code).toBe('TEST_AUDIO_UNAVAILABLE');
        expect(sm.requests.length).toBe(0);

        // Assert — nothing happened, so nothing is recorded as having
        // happened. Scoped to test-audio actions: the suite's own sign-in
        // writes a `login` row of its own.
        const rows = await dbCtx.db
          .selectFrom('admin_audit_log')
          .selectAll()
          .where('action', 'like', '%test-audio-device')
          .execute();
        expect(rows).toHaveLength(0);
      });
    }
  });
});

describe('Test audio routes, wired to a generator', () => {
  const server = useServer({
    testAudioConfig: { baseUrl: TEST_AUDIO_BASE_URL },
  });
  const dbCtx = useDb();
  let sm: SessionManagerMock;
  let cookie = '';
  let csrfToken = '';

  beforeAll(async () => {
    ({ cookie, csrfToken } = await login(server.fastify));
  });

  beforeEach(() => {
    sm = new SessionManagerMock();
  });
  afterEach(() => {
    sm.restore();
    // Undoes `useReadOnlyIdentity` — a leaked role downgrade would turn every
    // later mutation into a 403 that looks like a real guard working.
    vi.restoreAllMocks();
  });

  describe('reads', (it) => {
    it('lists both devices and injects the service key upstream (never from the browser)', async () => {
      // Arrange
      sm.respondWith({
        status: 200,
        body: { devices: [IDLE_GOOD, { ...IDLE_GOOD, deviceId: 'fault' }] },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: BASE,
        headers: { cookie },
      });

      // Assert — envelope, with the BFF's own `available` flag folded in
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: {
          available: true,
          devices: [IDLE_GOOD, { ...IDLE_GOOD, deviceId: 'fault' }],
        },
      });

      // Assert — the outgoing request carried the Bearer service key, and NOT
      // the admin session: the generator authenticates this service, not the
      // operator behind it.
      const upstream = sm.lastRequest;
      expect(upstream?.url).toBe(UPSTREAM_DEVICES_URL);
      expect(upstream?.method).toBe('GET');
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_AUDIO_SERVICE_KEY}`,
      );
      expect(upstream?.headers['cookie']).toBeUndefined();
      expect(upstream?.headers['x-csrf-token']).toBeUndefined();
    });

    it('surfaces a generator error as an error envelope rather than an empty panel', async () => {
      // Arrange — a CONFIGURED generator that fails is a fault, not a disabled
      // panel; answering `available: false` here would hide a broken service.
      sm.respondWith({ status: 500, body: { message: 'boom' } });

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: BASE,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(502);
      const body = res.json<ErrorBody>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('UPSTREAM_ERROR');
      expect(typeof body.error.requestId).toBe('string');
      // No internals: the operator gets a sentence, not a stack.
      expect(JSON.stringify(body)).not.toContain('boom');
    });
  });

  describe('mutation guards', (it) => {
    for (const mutation of MUTATIONS) {
      it(`rejects ${mutation.name} without a CSRF token (403) and makes NO upstream call`, async () => {
        // Arrange
        sm.respondWith({ status: 200, body: STREAMING_GOOD });

        // Act — authenticated, but no x-csrf-token header
        const res = await server.fastify.inject({
          method: mutation.method,
          url: mutation.url,
          headers: { cookie },
          payload: mutation.payload,
        });

        // Assert
        expect(res.statusCode).toBe(403);
        expect(res.json<ErrorBody>().error.code).toBe('CSRF_TOKEN_INVALID');
        expect(sm.requests.length).toBe(0);
      });

      it(`rejects ${mutation.name} from a read-only identity (403) and makes NO upstream call`, async () => {
        // Arrange
        sm.respondWith({ status: 200, body: STREAMING_GOOD });
        useReadOnlyIdentity();

        // Act — a complete, well-formed, CSRF-carrying request
        const res = await server.fastify.inject({
          method: mutation.method,
          url: mutation.url,
          headers: { cookie, 'x-csrf-token': csrfToken },
          payload: mutation.payload,
        });

        // Assert
        expect(res.statusCode).toBe(403);
        expect(res.json<ErrorBody>().error.code).toBe('FORBIDDEN');
        expect(sm.requests.length).toBe(0);
      });
    }
  });

  describe('mutations and audit', (it) => {
    it('starts a device, forwards the run to the generator, and audits the knobs', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: STREAMING_GOOD });
      const payload = {
        durationSec: 60,
        params: { clip: 'harvard', gainDb: -40, noiseType: 'white' },
      };

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/start`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload,
      });

      // Assert — response
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: STREAMING_GOOD });

      // Assert — upstream
      const upstream = sm.lastRequest;
      expect(upstream?.url).toBe(`${UPSTREAM_DEVICES_URL}/good/start`);
      expect(upstream?.method).toBe('POST');
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_AUDIO_SERVICE_KEY}`,
      );
      expect(upstream?.body).toEqual(payload);

      // Assert — the audit row names which knobs were turned, which is the
      // entire reason this row exists.
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'start-test-audio-device')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_subject).toBe('engrit');
      expect(rows[0]?.target).toBe('good');
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(200);
      expect(rows[0]?.params_summary).toEqual({
        durationSec: 60,
        params: payload.params,
      });
      // And carries no credential.
      expect(JSON.stringify(rows[0]?.params_summary)).not.toContain(
        TEST_AUDIO_SERVICE_KEY,
      );
    });

    it('stops a device and audits it', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: IDLE_GOOD });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/fault/stop`,
        headers: { cookie, 'x-csrf-token': csrfToken },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(sm.lastRequest?.url).toBe(`${UPSTREAM_DEVICES_URL}/fault/stop`);

      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'stop-test-audio-device')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target).toBe('fault');
      expect(rows[0]?.result).toBe('success');
    });

    it('retunes a running device with PATCH and audits only the knob that moved', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: STREAMING_GOOD });

      // Act
      const res = await server.fastify.inject({
        method: 'PATCH',
        url: `${BASE}/fault/params`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { speedup: 2 },
      });

      // Assert — a retune, not a restart: PATCH straight through to /params.
      expect(res.statusCode).toBe(200);
      expect(sm.lastRequest?.method).toBe('PATCH');
      expect(sm.lastRequest?.url).toBe(`${UPSTREAM_DEVICES_URL}/fault/params`);
      expect(sm.lastRequest?.body).toEqual({ speedup: 2 });

      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'retune-test-audio-device')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target).toBe('fault');
      expect(rows[0]?.params_summary).toEqual({ params: { speedup: 2 } });
    });
  });

  describe('input validation', (it) => {
    it('rejects an unknown device id (400) without a round trip', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/nope/start`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { durationSec: 60 },
      });

      // Assert
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR');
      expect(sm.requests.length).toBe(0);
    });

    it('rejects a start with no duration (400)', async () => {
      // Act — `durationSec` is what stops a forgotten device streaming into a
      // room, so it is required rather than defaulted.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/start`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { params: { gainDb: 0 } },
      });

      // Assert
      expect(res.statusCode).toBe(400);
      expect(sm.requests.length).toBe(0);
    });

    it('rejects a body that mixes a good knob with a fault knob (400)', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'PATCH',
        url: `${BASE}/good/params`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { gainDb: 0, speedup: 2 },
      });

      // Assert
      expect(res.statusCode).toBe(400);
      expect(sm.requests.length).toBe(0);
    });

    it('rejects a gain outside the range the device supports (400)', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'PATCH',
        url: `${BASE}/good/params`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { gainDb: 60 },
      });

      // Assert
      expect(res.statusCode).toBe(400);
      expect(sm.requests.length).toBe(0);
    });
  });

  describe('upstream failures', (it) => {
    it('passes a generator 409 through at its own status and code, and audits the failure', async () => {
      // Arrange — starting a device that is already running.
      sm.respondWith({
        status: 409,
        body: { code: 'DEVICE_BUSY', message: 'good is already streaming' },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/start`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { durationSec: 60 },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      const body = res.json<ErrorBody>();
      expect(body.error.code).toBe('DEVICE_BUSY');
      expect(body.error.message).toBe('good is already streaming');

      // Assert — audit and response agree about what happened.
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'start-test-audio-device')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('failure');
      expect(rows[0]?.status_code).toBe(409);
    });

    it('maps a rejected service key (401) to 502 BACKEND_MISCONFIGURATION, never 401', async () => {
      // Arrange
      sm.respondWith({ status: 401, body: { code: 'INVALID_SERVICE_KEY' } });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/stop`,
        headers: { cookie, 'x-csrf-token': csrfToken },
      });

      // Assert — a 401 here would bounce the operator to the login page over
      // an .env mistake.
      expect(res.statusCode).toBe(502);
      expect(res.json<ErrorBody>().error.code).toBe('BACKEND_MISCONFIGURATION');
    });

    it('maps a generator 500 to a 502 envelope, not a 500 with a stack', async () => {
      // Arrange
      sm.respondWith({
        status: 500,
        body: { message: 'TypeError: cannot read property of undefined' },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/stop`,
        headers: { cookie, 'x-csrf-token': csrfToken },
      });

      // Assert
      expect(res.statusCode).toBe(502);
      const body = res.json<ErrorBody>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('UPSTREAM_ERROR');
      expect(body.error.message).not.toContain('TypeError');
    });
  });
});

describe('Test audio routes, generator configured but unreachable', () => {
  // A port nothing listens on, so the connection is refused immediately —
  // the same trick the fleet suite uses for an absent Redis. No fetch mock
  // here on purpose: this exercises the real network failure path.
  const server = useServer({
    testAudioConfig: { baseUrl: 'http://127.0.0.1:1' },
  });
  const dbCtx = useDb();
  let cookie = '';
  let csrfToken = '';

  beforeAll(async () => {
    ({ cookie, csrfToken } = await login(server.fastify));
  });

  describe('degraded', (it) => {
    it('answers the read 503 TEST_AUDIO_UNREACHABLE, not 500 and not an empty panel', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: BASE,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(503);
      const body = res.json<ErrorBody>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('TEST_AUDIO_UNREACHABLE');
      expect(typeof body.error.requestId).toBe('string');
    });

    it('answers a mutation 503 and records the attempt as a failure', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/good/start`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { durationSec: 30 },
      });

      // Assert
      expect(res.statusCode).toBe(503);
      expect(res.json<ErrorBody>().error.code).toBe('TEST_AUDIO_UNREACHABLE');

      // Assert — an attempted mutation that reached the upstream (and failed)
      // IS recorded, unlike one refused before the gateway was called.
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'start-test-audio-device')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('failure');
      expect(rows[0]?.status_code).toBe(503);
    });
  });
});
