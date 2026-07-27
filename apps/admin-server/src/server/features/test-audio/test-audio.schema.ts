import { Type } from 'typebox';
import type { Static } from 'typebox';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

const P = `${ADMIN_BASE_PATH}/test-audio`;

/**
 * Input validation for the operator test-audio panel
 * (PLAN-TestAudioDevices §3).
 *
 * Unlike `rooms`/`devices`, these shapes are declared here rather than imported
 * from a schema package: the upstream is `apps/test-audio-generator`, an
 * internal service with no generated client or published schema lib. They are
 * a hand-written restatement of PLAN §2, and the generator stays authoritative
 * — anything this accepts that it does not is answered by its own 4xx, which
 * the gateway passes through.
 *
 * NEVER the `authorization` header: the BFF injects the service key
 * server-side, and the admin session never reaches the upstream.
 */

/** The two provisioned devices (PLAN §2). Rejected here, not upstream. */
export const DEVICE_ID_SCHEMA = Type.Union([
  Type.Literal('good'),
  Type.Literal('fault'),
]);

export type TestAudioDeviceId = Static<typeof DEVICE_ID_SCHEMA>;

const DEVICE_PARAMS = Type.Object({ deviceId: DEVICE_ID_SCHEMA });

/**
 * Device 1 — `good` (PLAN §2.1). Every knob optional: the generator owns the
 * defaults, so a start with no parameters plays the clip clean and a retune
 * carries only what the operator moved.
 *
 * `gainDb` spans −40 (below the ingress meter's silence floor) to +20 (hard
 * clipping) deliberately — both ends are the parameter's purpose, so neither
 * is narrowed here.
 */
const GOOD_PARAMS_SCHEMA = Type.Object(
  {
    clip: Type.Optional(
      Type.Union([
        Type.Literal('harvard'),
        Type.Literal('apollo'),
        Type.Literal('longform'),
      ]),
    ),
    gainDb: Type.Optional(Type.Integer({ minimum: -40, maximum: 20 })),
    noiseType: Type.Optional(
      Type.Union([
        Type.Literal('none'),
        Type.Literal('white'),
        Type.Literal('brown'),
      ]),
    ),
    // Five fixed levels rather than a slider, per PLAN §2.1.
    noiseDb: Type.Optional(
      Type.Union([
        Type.Literal(-60),
        Type.Literal(-50),
        Type.Literal(-40),
        Type.Literal(-30),
        Type.Literal(-20),
      ]),
    ),
  },
  { additionalProperties: false },
);

/**
 * Device 2 — `fault` (PLAN §2.2). One knob per fault, all independently
 * settable, all defaulting to zero upstream so an unparameterized start
 * streams clean audio.
 */
const FAULT_PARAMS_SCHEMA = Type.Object(
  {
    clipPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    stutterPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    dropPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    speedup: Type.Optional(Type.Number({ minimum: 1, maximum: 3 })),
    silencePct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    dcOffset: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    corruptPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    badHeaderPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    clockSkewMs: Type.Optional(
      Type.Integer({ minimum: -5000, maximum: 5000 }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Either device's knobs, partially applied.
 *
 * A union rather than one flat object, and `additionalProperties: false` on
 * both halves, so that a body mixing a `good` knob with a `fault` knob is a
 * 400 here instead of a request the generator has to reason about. Which half
 * a body belongs to is decided by the knobs it names; `{}` matches both, which
 * is correct — an empty retune is a no-op either way.
 */
export const DEVICE_PARAMS_SCHEMA = Type.Union([
  GOOD_PARAMS_SCHEMA,
  FAULT_PARAMS_SCHEMA,
]);

export type TestAudioParams = Static<typeof DEVICE_PARAMS_SCHEMA>;

/**
 * Upper bound on a run, in seconds.
 *
 * Deliberately looser than the generator's own `TEST_AUDIO_MAX_DURATION_SEC`
 * (default 1800): the authoritative cap belongs to the process that has to
 * honour it, and restating 1800 here would silently disagree with a deployment
 * that lowers it. This exists only so an absurd value is rejected without a
 * round trip; the generator's cap is what stops a device streaming overnight.
 */
export const MAX_REQUESTED_DURATION_SEC = 86_400;

// ---- Routes ----

// No input schema: the read takes no params, querystring or body, so it is
// declared like `FLEET_ROUTE` rather than with an empty `{}`.
export const LIST_TEST_AUDIO_ROUTE = { method: 'GET' as const, url: P };

export const START_DEVICE_INPUT = {
  params: DEVICE_PARAMS,
  body: Type.Object(
    {
      params: Type.Optional(DEVICE_PARAMS_SCHEMA),
      durationSec: Type.Integer({
        minimum: 1,
        maximum: MAX_REQUESTED_DURATION_SEC,
      }),
    },
    { additionalProperties: false },
  ),
};
export const START_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/:deviceId/start`,
};

export const STOP_DEVICE_INPUT = { params: DEVICE_PARAMS };
export const STOP_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/:deviceId/stop`,
};

export const UPDATE_PARAMS_INPUT = {
  params: DEVICE_PARAMS,
  body: DEVICE_PARAMS_SCHEMA,
};
export const UPDATE_PARAMS_ROUTE = {
  method: 'PATCH' as const,
  url: `${P}/:deviceId/params`,
};

/**
 * One device's state as the generator reports it (PLAN §2).
 *
 * Documentation of the upstream contract, not a validation schema: like every
 * other proxied read in this BFF, the upstream body is passed through as it
 * arrived rather than re-validated here, so that a generator that adds a field
 * does not need an admin-server release to surface it.
 */
export interface TestAudioDeviceState {
  deviceId: TestAudioDeviceId;
  /** A device token is provisioned for it. */
  configured: boolean;
  state: 'idle' | 'connecting' | 'streaming' | 'error';
  params: TestAudioParams;
  sessionUid: string | null;
  roomName: string | null;
  startedAtMs: number | null;
  expiresAtMs: number | null;
  framesSent: number;
  /** Frames the fault engine altered. */
  framesFaulted: number;
  transcriptCount: number;
  lastTranscript: string | null;
  error: string | null;
}

/**
 * What `GET /test-audio` answers with.
 *
 * `available` is the BFF's own addition, not the generator's: an unprovisioned
 * deployment gets `{ available: false, devices: [] }` at 200 so the SPA renders
 * a disabled panel rather than an error (PLAN §3).
 */
export interface TestAudioPanel {
  available: boolean;
  devices: TestAudioDeviceState[];
}
