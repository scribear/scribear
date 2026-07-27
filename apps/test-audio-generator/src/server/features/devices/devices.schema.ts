import { Type } from 'typebox';

import {
  CLIP_IDS,
  CLOCK_SKEW_MS_MAX,
  CLOCK_SKEW_MS_MIN,
  FAULT_PARAM_DEFAULTS,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GOOD_PARAM_DEFAULTS,
  NOISE_DB_LEVELS,
  NOISE_TYPES,
  SPEEDUP_MAX,
  SPEEDUP_MIN,
} from '@scribear/test-audio-source';

import { TEST_AUDIO_BASE_PATH } from '#src/server/base-path.js';

/**
 * The control API's wire shapes (PLAN-TestAudioDevices §2).
 *
 * These must agree with `apps/admin-server/.../test-audio.schema.ts`, which is
 * a hand-written restatement of the same section. The BFF is the only caller
 * and its 28 integration tests are written against these shapes; anything this
 * rejects that the BFF accepts becomes a 400 the operator sees with no
 * explanation of which half disagreed.
 *
 * Bounds come from `@scribear/test-audio-source`'s `params.ts` rather than
 * being restated as literals, so that the schema and the clamping the engine
 * actually applies cannot drift. The clamp remains the enforcement — this is
 * the courtesy 400.
 */

const P = `${TEST_AUDIO_BASE_PATH}/devices`;

export const DEVICE_ID_SCHEMA = Type.Union([
  Type.Literal('good'),
  Type.Literal('fault'),
]);

const DEVICE_PARAMS = Type.Object({ deviceId: DEVICE_ID_SCHEMA });

/**
 * Device 1 — `good` (§2.1). Every knob optional: this service owns the
 * defaults, so a start with no parameters plays the clip clean and a retune
 * carries only the knob the operator moved.
 */
export const GOOD_PARAMS_SCHEMA = Type.Object(
  {
    clip: Type.Optional(Type.Union(CLIP_IDS.map((clip) => Type.Literal(clip)))),
    // Both ends are meant to be reachable: -40 dB is below the ingress meter's
    // silence floor and +20 dB drives the fixture into hard clipping. That is
    // what the parameter is for, so neither end is narrowed.
    gainDb: Type.Optional(
      Type.Integer({ minimum: GAIN_DB_MIN, maximum: GAIN_DB_MAX }),
    ),
    noiseType: Type.Optional(
      Type.Union(NOISE_TYPES.map((noiseType) => Type.Literal(noiseType))),
    ),
    // Five fixed levels rather than a slider, per §2.1.
    noiseDb: Type.Optional(
      Type.Union(NOISE_DB_LEVELS.map((noiseDb) => Type.Literal(noiseDb))),
    ),
  },
  { additionalProperties: false },
);

/** Device 2 — `fault` (§2.2). One knob per fault, all independently settable. */
export const FAULT_PARAMS_SCHEMA = Type.Object(
  {
    clipPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    stutterPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    dropPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    speedup: Type.Optional(
      Type.Number({ minimum: SPEEDUP_MIN, maximum: SPEEDUP_MAX }),
    ),
    silencePct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    dcOffset: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    corruptPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    badHeaderPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    clockSkewMs: Type.Optional(
      Type.Integer({ minimum: CLOCK_SKEW_MS_MIN, maximum: CLOCK_SKEW_MS_MAX }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Either device's knobs, partially applied — the shape the BFF forwards.
 *
 * A union with `additionalProperties: false` on both halves, so a body mixing a
 * `good` knob with a `fault` knob is a 400 rather than something to reason
 * about. `{}` matches both, which is correct: an empty retune is a no-op either
 * way. What the union cannot express is *which* device a body was addressed to,
 * because the id is a path parameter; {@link GOOD_PARAM_KEYS} and
 * {@link FAULT_PARAM_KEYS} close that gap in the controller.
 */
export const DEVICE_PARAMS_SCHEMA = Type.Union([
  GOOD_PARAMS_SCHEMA,
  FAULT_PARAMS_SCHEMA,
]);

/**
 * The knob names each device has, derived from the defaults so a knob added to
 * the library cannot be silently unroutable here.
 */
export const GOOD_PARAM_KEYS: readonly string[] =
  Object.keys(GOOD_PARAM_DEFAULTS);
export const FAULT_PARAM_KEYS: readonly string[] =
  Object.keys(FAULT_PARAM_DEFAULTS);

// ---- Routes ----

export const LIST_DEVICES_ROUTE = { method: 'GET' as const, url: P };

export const START_DEVICE_INPUT = {
  params: DEVICE_PARAMS,
  body: Type.Object(
    {
      params: Type.Optional(DEVICE_PARAMS_SCHEMA),
      /**
       * Required, per §2, and capped by `TEST_AUDIO_MAX_DURATION_SEC` — which
       * is enforced in the run manager rather than here, because the cap is
       * deployment-configurable and a schema cannot read it. An over-cap
       * request is a 422 naming the limit, not a 400.
       */
      durationSec: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
};
export const START_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/:deviceId/start`,
};

/**
 * No body schema, deliberately: the BFF's gateway sends this with no body and
 * no `content-type` at all, which Fastify treats as an empty body. Declaring
 * even an empty object schema would make every stop a 400.
 */
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
