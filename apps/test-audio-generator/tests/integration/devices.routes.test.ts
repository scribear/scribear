import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import type { DeviceState } from '#src/server/shared/devices/device-state.js';

/**
 * The control API as `TestAudioGatewayService` actually calls it.
 *
 * The BFF is committed and its 28 integration tests pass against a mock of this
 * contract; this suite is the other half of that pair. Everything asserted here
 * — the exact paths, the bare-JSON bodies, the `code`/`message` on a 4xx — is
 * something that gateway reads, so a change that these tolerate and it does not
 * would surface as an unexplained error on the operator's page.
 */

const BASE = '/api/test-audio/v1';
const DEVICES = `${BASE}/devices`;
const SERVICE_KEY = 'integration-test-service-key';
const DEVICE_SECRET = 'integration-test-device-secret';

function repoFile(relative: string): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not locate ${relative}`);
    dir = parent;
  }
}

interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Boots the real server with the background room refresh disabled.
 *
 * Both upstreams point at a closed port rather than being mocked: a device that
 * is *configured* must be startable, and what happens after it is started is
 * beyond this suite. A refused connection ends the background run in
 * milliseconds and, more to the point, guarantees nothing here reaches the
 * network.
 */
async function boot({ secret = '' }: { secret?: string } = {}) {
  process.env['LOG_LEVEL'] = 'silent';
  process.env['PORT'] = '0';
  process.env['HOST'] = '127.0.0.1';
  process.env['TEST_AUDIO_SERVICE_KEY'] = SERVICE_KEY;
  // One secret arms both devices, or neither. There is no longer a
  // one-provisioned-one-not state to boot into: the tokens are derived from
  // this value, so it configures the pair.
  process.env['TEST_AUDIO_DEVICE_SECRET'] = secret;
  process.env['SESSION_MANAGER_BASE_URL'] = 'http://127.0.0.1:1';
  process.env['NODE_SERVER_BASE_URL'] = 'http://127.0.0.1:1';
  process.env['TEST_AUDIO_REQUEST_TIMEOUT_SEC'] = '1';
  process.env['TEST_AUDIO_UPSTREAM_WAIT_SEC'] = '1';
  process.env['TEST_AUDIO_MAX_DURATION_SEC'] = '1800';
  process.env['TEST_AUDIO_LONGFORM_URL'] = '';
  process.env['TEST_AUDIO_HARVARD_PATH'] = repoFile(
    'test_audio_files/speech/harvard_16k_mono.wav',
  );
  process.env['TEST_AUDIO_APOLLO_PATH'] = repoFile(
    'test_audio_files/speech/apollo11_dialogue_16k_mono.wav',
  );

  const config = new AppConfig();
  const { fastify } = await createServer(config, {
    startBackgroundWork: false,
  });
  await fastify.ready();
  return fastify;
}

const AUTH = { authorization: `Bearer ${SERVICE_KEY}` };

describe('control API', () => {
  let fastify: BaseFastifyInstance;

  afterEach(async () => {
    await fastify.close();
  });

  describe('service-key auth', () => {
    beforeEach(async () => {
      fastify = await boot({ secret: DEVICE_SECRET });
    });

    const ROUTES = [
      { name: 'list', method: 'GET' as const, url: DEVICES },
      { name: 'start', method: 'POST' as const, url: `${DEVICES}/good/start` },
      { name: 'stop', method: 'POST' as const, url: `${DEVICES}/good/stop` },
      {
        name: 'params',
        method: 'PATCH' as const,
        url: `${DEVICES}/good/params`,
      },
    ];

    describe('every control route', (it) => {
      for (const route of ROUTES) {
        it(`rejects ${route.name} with no key`, async () => {
          // Act
          const res = await fastify.inject({
            method: route.method,
            url: route.url,
            ...(route.method === 'GET' ? {} : { payload: {} }),
          });

          // Assert — including the read: it reports which rooms these devices
          // reach and what the last captions were.
          expect(res.statusCode).toBe(401);
          expect(res.json<ErrorBody>().code).toBe('UNAUTHORIZED');
        });

        it(`rejects ${route.name} with the wrong key`, async () => {
          // Act
          const res = await fastify.inject({
            method: route.method,
            url: route.url,
            headers: { authorization: 'Bearer not-the-key' },
            ...(route.method === 'GET' ? {} : { payload: {} }),
          });

          // Assert
          expect(res.statusCode).toBe(401);
        });
      }
    });

    describe('the probes', (it) => {
      it('are open, because the container HEALTHCHECK has no key', async () => {
        // Act
        const res = await fastify.inject({
          method: 'GET',
          url: `${BASE}/probes/liveness`,
        });

        // Assert
        expect(res.statusCode).toBe(200);
        expect(res.json()).toStrictEqual({ status: 'ok' });
      });

      it('report ready once a device has a token', async () => {
        // Act
        const res = await fastify.inject({
          method: 'GET',
          url: `${BASE}/probes/readiness`,
        });

        // Assert
        expect(res.statusCode).toBe(200);
      });
    });
  });

  describe('with no device secret set (the default)', () => {
    beforeEach(async () => {
      fastify = await boot();
    });

    describe('readiness', (it) => {
      it('is 503, so the forgotten .env line shows in `docker compose ps`', async () => {
        // Act
        const res = await fastify.inject({
          method: 'GET',
          url: `${BASE}/probes/readiness`,
        });

        // Assert
        expect(res.statusCode).toBe(503);
        expect(
          res.json<{ checks: { devices: string } }>().checks.devices,
        ).toMatch(/no device credential configured/);
      });
    });

    describe('the device list', (it) => {
      it('still lists both devices, marked unconfigured', async () => {
        // Act — the BFF turns this into a disabled panel; an empty list would
        // be indistinguishable from a generator that lost its devices.
        const res = await fastify.inject({
          method: 'GET',
          url: DEVICES,
          headers: AUTH,
        });

        // Assert
        expect(res.statusCode).toBe(200);
        const { devices } = res.json<{ devices: DeviceState[] }>();
        expect(devices.map((d) => d.deviceId)).toStrictEqual(['good', 'fault']);
        expect(devices.every((d) => !d.configured)).toBe(true);
      });
    });

    describe('start', (it) => {
      it('is a 422 DEVICE_NOT_CONFIGURED the BFF passes straight through', async () => {
        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 60 },
        });

        // Assert — a 5xx would be flattened to UPSTREAM_ERROR by the gateway
        // and the operator would never learn which device is missing a token.
        expect(res.statusCode).toBe(422);
        const body = res.json<ErrorBody>();
        expect(body.code).toBe('DEVICE_NOT_CONFIGURED');
        expect(body.message).toMatch(/TEST_AUDIO_DEVICE_SECRET/);
      });
    });
  });

  describe('with a device secret set', () => {
    beforeEach(async () => {
      fastify = await boot({ secret: DEVICE_SECRET });
    });

    async function list(): Promise<DeviceState[]> {
      const res = await fastify.inject({
        method: 'GET',
        url: DEVICES,
        headers: AUTH,
      });
      return res.json<{ devices: DeviceState[] }>().devices;
    }

    describe('the read', (it) => {
      it('answers bare JSON under `devices`, not an envelope', async () => {
        // Act
        const res = await fastify.inject({
          method: 'GET',
          url: DEVICES,
          headers: AUTH,
        });

        // Assert — the gateway reads `body.devices` directly and wraps the
        // result in `okEnvelope` itself; two envelopes would mean unwrapping
        // one to build the other.
        expect(res.statusCode).toBe(200);
        const body = res.json<Record<string, unknown>>();
        expect(Object.keys(body)).toStrictEqual(['devices']);
      });

      it('reports every field PLAN §2 declares', async () => {
        // Act
        const [good] = await list();

        // Assert — the BFF passes this body through untouched, so a field
        // dropped here vanishes from the operator's page with nothing failing
        // in between.
        expect(good).toStrictEqual({
          deviceId: 'good',
          configured: true,
          state: 'idle',
          params: {
            clip: 'harvard',
            gainDb: 0,
            noiseType: 'none',
            noiseDb: -60,
          },
          sessionUid: null,
          roomName: null,
          startedAtMs: null,
          expiresAtMs: null,
          framesSent: 0,
          framesFaulted: 0,
          transcriptCount: 0,
          lastTranscript: null,
          error: null,
        });
      });

      it('starts the fault device with every knob at zero', async () => {
        // Act — a `fault` device started with no parameters streams clean
        // audio, so the operator turns on exactly the fault they came to see.
        const [, fault] = await list();

        // Assert
        expect(fault?.params).toStrictEqual({
          clipPct: 0,
          stutterPct: 0,
          dropPct: 0,
          speedup: 1,
          silencePct: 0,
          dcOffset: 0,
          corruptPct: 0,
          badHeaderPct: 0,
          clockSkewMs: 0,
        });
      });
    });

    describe('start', (it) => {
      it('returns the DeviceState directly, connecting, with the knobs applied', async () => {
        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: {
            durationSec: 60,
            params: { clip: 'apollo', gainDb: -12, noiseType: 'white' },
          },
        });

        // Assert
        expect(res.statusCode).toBe(200);
        const state = res.json<DeviceState>();
        expect(state.state).toBe('connecting');
        expect(state.params).toMatchObject({
          clip: 'apollo',
          gainDb: -12,
          noiseType: 'white',
        });
        expect(state.expiresAtMs).toBeGreaterThan(Date.now());
      });

      it('is a 409 DEVICE_BUSY on an already-running device', async () => {
        // Arrange
        await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 600 },
        });

        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 600 },
        });

        // Assert
        expect(res.statusCode).toBe(409);
        expect(res.json<ErrorBody>().code).toBe('DEVICE_BUSY');
      });

      it('is a 422 DURATION_TOO_LONG over the cap, naming the cap', async () => {
        // Act — this cap is the authoritative one; admin-server's schema only
        // rejects absurd values, so a deployment that lowers this is obeyed.
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 7200 },
        });

        // Assert
        expect(res.statusCode).toBe(422);
        const body = res.json<ErrorBody>();
        expect(body.code).toBe('DURATION_TOO_LONG');
        expect(body.details).toMatchObject({ maxDurationSec: 1800 });
      });

      it('requires durationSec, so a run cannot be unbounded', async () => {
        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { params: { gainDb: 0 } },
        });

        // Assert
        expect(res.statusCode).toBe(400);
        expect(res.json<ErrorBody>().code).toBe('VALIDATION_ERROR');
      });

      it('rejects a knob outside its stated range', async () => {
        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 60, params: { gainDb: 99 } },
        });

        // Assert
        expect(res.statusCode).toBe(400);
      });

      it('rejects an unknown device id at the route, not in the manager', async () => {
        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/sneaky/start`,
          headers: AUTH,
          payload: { durationSec: 60 },
        });

        // Assert
        expect(res.statusCode).toBe(400);
      });
    });

    describe('stop', (it) => {
      it('accepts a request with no body and no content-type', async () => {
        // Arrange — this is exactly how `TestAudioGatewayService` sends it: no
        // body, and therefore no content-type header at all. A route declaring
        // even an empty body schema would 400 every stop.
        await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/fault/start`,
          headers: AUTH,
          payload: { durationSec: 600 },
        });

        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/fault/stop`,
          headers: AUTH,
        });

        // Assert
        expect(res.statusCode).toBe(200);
        expect(res.json<DeviceState>().state).not.toBe('streaming');
      });

      it('is a 200 no-op on an idle device', async () => {
        // Act — stop is the operator's remedy for a device in an unexpected
        // state, so it must not itself be an error.
        const res = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/stop`,
          headers: AUTH,
        });

        // Assert
        expect(res.statusCode).toBe(200);
        expect(res.json<DeviceState>().state).toBe('idle');
      });
    });

    describe('retune', (it) => {
      it('applies to an idle device as pending parameters', async () => {
        // Act
        const res = await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/fault/params`,
          headers: AUTH,
          payload: { speedup: 2 },
        });

        // Assert
        expect(res.statusCode).toBe(200);
        expect(res.json<DeviceState>().params).toMatchObject({ speedup: 2 });

        // Assert — and it is what the next run will start with.
        const [, fault] = await list();
        expect(fault?.params).toMatchObject({ speedup: 2 });
      });

      it('carries only the knob that moved, leaving the rest alone', async () => {
        // Arrange
        await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/fault/params`,
          headers: AUTH,
          payload: { dropPct: 30 },
        });

        // Act
        const res = await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/fault/params`,
          headers: AUTH,
          payload: { clipPct: 10 },
        });

        // Assert
        expect(res.json<DeviceState>().params).toMatchObject({
          dropPct: 30,
          clipPct: 10,
        });
      });

      it('rejects a knob the addressed device does not have', async () => {
        // Act — `speedup` is a fault knob. Without this check the body would
        // validate against the union, clamp away to nothing and answer 200: the
        // operator would turn a knob, see it succeed, and watch for an effect
        // that was never going to arrive.
        const res = await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/good/params`,
          headers: AUTH,
          payload: { speedup: 2 },
        });

        // Assert
        expect(res.statusCode).toBe(400);
        const body = res.json<ErrorBody>();
        expect(body.code).toBe('UNKNOWN_DEVICE_PARAMS');
        expect(body.details).toMatchObject({ unknownParams: ['speedup'] });
      });

      it('rejects a body mixing a good knob with a fault knob', async () => {
        // Act
        const res = await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/good/params`,
          headers: AUTH,
          payload: { gainDb: -6, speedup: 2 },
        });

        // Assert
        expect(res.statusCode).toBe(400);
      });

      it('accepts an empty retune as the no-op it is', async () => {
        // Act
        const res = await fastify.inject({
          method: 'PATCH',
          url: `${DEVICES}/good/params`,
          headers: AUTH,
          payload: {},
        });

        // Assert
        expect(res.statusCode).toBe(200);
      });
    });

    describe('the two devices', (it) => {
      it('run at once, which is why they have a room each', async () => {
        // Act
        const good = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/good/start`,
          headers: AUTH,
          payload: { durationSec: 600 },
        });
        const fault = await fastify.inject({
          method: 'POST',
          url: `${DEVICES}/fault/start`,
          headers: AUTH,
          payload: { durationSec: 600, params: { speedup: 2 } },
        });

        // Assert — a room has exactly one source device, so one room could not
        // hold both. That is the whole reason provisioning creates two.
        expect(good.statusCode).toBe(200);
        expect(fault.statusCode).toBe(200);
        const devices = await list();
        expect(devices.every((d) => d.state === 'connecting')).toBe(true);
      });
    });
  });
});
