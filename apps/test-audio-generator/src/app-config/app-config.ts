import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';
import {
  TEST_AUDIO_DEVICE_UIDS,
  deriveTestAudioDeviceToken,
} from '@scribear/session-manager-schema/test-audio';

import type { ServiceAuthConfig } from '#src/server/shared/auth/service-auth.service.js';
import type { ClipCatalogConfig } from '#src/server/shared/clips/clip-catalog.service.js';
import { DEFAULT_LONGFORM_URL } from '#src/server/shared/clips/longform.js';
import type { DeviceRunManagerConfig } from '#src/server/shared/devices/device-run-manager.service.js';

const SECOND_MS = 1_000;

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),

  /**
   * The inbound service key, presented by admin-server's test-audio BFF as
   * `Authorization: Bearer`. Must match its `TEST_AUDIO_SERVICE_KEY`.
   *
   * Required, with no usable default: this key is the only thing between a
   * caller on the backend network and the ability to stream audio into a live
   * room. An empty value would match the empty credential an unauthenticated
   * caller presents, so the service refuses to start on one — see
   * `assertUsableServiceKey`.
   */
  TEST_AUDIO_SERVICE_KEY: Type.String({ default: '' }),

  // --- The two devices' credentials -----------------------------------------
  /**
   * The one secret this service needs to authenticate as both of its devices.
   *
   * It holds no device *tokens*. The Session Manager seeds the two rooms and
   * the two source devices at fixed uids and stores
   * `bcrypt(derive(secret, deviceUid))` as each device's credential; this
   * service derives the same secret from the same two inputs and presents
   * `{deviceUid}:{secret}`. Nothing is ever copied between the two services —
   * they agree because they compute the same function — so there is no
   * provisioning script, no `Set-Cookie` header to scrape, and no `.env` line to
   * paste. Must be the same value on both.
   *
   * Empty — the default — means **both** devices report `configured: false` and
   * refuse to start, and the Session Manager seeds nothing at all. That is the
   * inert state a deployment that has not asked for this feature is in.
   *
   * SECURITY: a device token reaches **only its own device's room**. Neither
   * device has any way to name another, so the room each is seeded into is the
   * entire safety boundary — pointing one at a teaching room would inject
   * fixture speech into that lecture's live captions, silently and with nothing
   * to notice it. Seeding that assignment in code is *stronger* than wiring it
   * by hand: it names two reserved rooms no database-generated uid can collide
   * with, and room-management refuses to reassign either device out of its own
   * room (`TEST_AUDIO_DEVICE_NOT_ASSIGNABLE`).
   *
   * This service deliberately holds nothing else: no `ADMIN_API_KEY` (which
   * would let it create sessions in any room) and no `SESSION_TOKEN_SIGNING_KEY`
   * (which would let it forge a token for any session in the fleet).
   */
  TEST_AUDIO_DEVICE_SECRET: Type.String({ default: '' }),

  SESSION_MANAGER_BASE_URL: Type.String({
    default: 'http://session-manager:80',
  }),
  NODE_SERVER_BASE_URL: Type.String({ default: 'http://node-server:80' }),

  // --- Run bounds -----------------------------------------------------------
  /**
   * Hard ceiling on a single run, in seconds. 30 minutes.
   *
   * Every run auto-stops at its own `durationSec` with no further instruction,
   * and this bounds what may be asked for. It is the authoritative cap:
   * admin-server's schema rejects only absurd values and says so, precisely so
   * that a deployment lowering this number is obeyed rather than contradicted.
   */
  TEST_AUDIO_MAX_DURATION_SEC: Type.Integer({ minimum: 1, default: 1_800 }),
  /** Per-request bound on session-manager calls. */
  TEST_AUDIO_REQUEST_TIMEOUT_SEC: Type.Integer({ minimum: 1, default: 5 }),
  /** How long to wait for sockets to open and the upstream to report ready. */
  TEST_AUDIO_UPSTREAM_WAIT_SEC: Type.Integer({ minimum: 1, default: 20 }),
  /**
   * How often the devices re-read which room they belong to.
   *
   * On a timer rather than per request because `GET /devices` is polled every
   * 3 s by an open admin page, and a value that changes only on re-provisioning
   * does not deserve two session-manager round trips per poll.
   */
  TEST_AUDIO_ROOM_REFRESH_SEC: Type.Integer({ minimum: 5, default: 60 }),

  // --- Audio ----------------------------------------------------------------
  /**
   * Chunk duration. 100 ms matches the kiosk's `AUDIO_CHUNK_MS`, so these
   * devices frame audio at the same rate real source devices do — which is what
   * makes a fault reproduced here a fault a real source could produce.
   */
  TEST_AUDIO_CHUNK_MS: Type.Integer({ minimum: 10, default: 100 }),
  /**
   * Must equal `sample_rate` / `num_channels` in the test rooms' sessions'
   * `transcriptionStreamConfig`. The transcription service raises on a mismatch
   * rather than resampling, so a wrong value here means every frame is
   * rejected — which is why the clip catalog checks each fixture against these
   * at load rather than letting it fail one frame at a time.
   */
  TEST_AUDIO_SAMPLE_RATE: Type.Integer({ minimum: 1, default: 16_000 }),
  TEST_AUDIO_CHANNELS: Type.Integer({ minimum: 1, default: 1 }),

  /** Paths as laid down by the Dockerfile. */
  TEST_AUDIO_HARVARD_PATH: Type.String({
    default: '/app/test_audio_files/speech/harvard_16k_mono.wav',
  }),
  TEST_AUDIO_APOLLO_PATH: Type.String({
    default: '/app/test_audio_files/speech/apollo11_dialogue_16k_mono.wav',
  }),
  /**
   * The `longform` clip, built at image-build time rather than committed: five
   * minutes of 16 kHz mono WAV is ~9.6 MB and derived from public sources.
   * Missing at runtime, it is built on first use instead.
   */
  TEST_AUDIO_LONGFORM_PATH: Type.String({
    default: '/app/test_audio_files/longform/longform_16k_mono.wav',
  }),
  /**
   * Where the longform clip is downloaded from. See `DEFAULT_LONGFORM_URL` for
   * what it is and why LibriVox itself could not be used. Set it empty on a
   * build host with no egress: the build then concatenates the two committed
   * fixtures and says so in its log, and nothing fails.
   */
  TEST_AUDIO_LONGFORM_URL: Type.String({ default: DEFAULT_LONGFORM_URL }),
  TEST_AUDIO_LONGFORM_SEC: Type.Integer({ minimum: 1, default: 300 }),
  TEST_AUDIO_LONGFORM_TIMEOUT_SEC: Type.Integer({ minimum: 1, default: 60 }),

  /**
   * The clip the `fault` device streams. `FaultParams` has no clip knob — §2.2
   * is one knob per fault and nothing else — so the source material is
   * configuration. `harvard` by default: it is the fixture with a reference
   * transcript, so a fault's effect on the words can be judged against
   * something.
   */
  TEST_AUDIO_FAULT_CLIP: Type.Union(
    [Type.Literal('harvard'), Type.Literal('apollo'), Type.Literal('longform')],
    { default: 'harvard' },
  ),
  /**
   * Seed for the fault engine's draws.
   *
   * Fixed by default so that a run an operator reports can be reproduced
   * exactly: "30% drop, seed 1" is a specific sequence of dropped frames rather
   * than a distribution. Change it to see a different one.
   */
  TEST_AUDIO_RNG_SEED: Type.Integer({ default: 1 }),
});

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

export class AppConfig {
  private _isDevelopment: boolean;
  private _env: Static<typeof CONFIG_SCHEMA>;

  get baseConfig(): BaseConfig {
    return {
      isDevelopment: this._isDevelopment,
      logLevel: this._env.LOG_LEVEL,
      port: this._env.PORT,
      host: this._env.HOST,
    };
  }

  get serviceAuthConfig(): ServiceAuthConfig {
    return { serviceKey: this._env.TEST_AUDIO_SERVICE_KEY };
  }

  get clipCatalogConfig(): ClipCatalogConfig {
    return {
      clipPaths: {
        harvard: this._env.TEST_AUDIO_HARVARD_PATH,
        apollo: this._env.TEST_AUDIO_APOLLO_PATH,
        longform: this._env.TEST_AUDIO_LONGFORM_PATH,
      },
      longform: {
        sourceUrl: this._env.TEST_AUDIO_LONGFORM_URL,
        // Both committed fixtures, so the fallback has two distinguishable
        // voices to interleave rather than one clip repeated.
        fallbackPaths: [
          this._env.TEST_AUDIO_HARVARD_PATH,
          this._env.TEST_AUDIO_APOLLO_PATH,
        ],
        targetSec: this._env.TEST_AUDIO_LONGFORM_SEC,
        sampleRate: this._env.TEST_AUDIO_SAMPLE_RATE,
        channels: this._env.TEST_AUDIO_CHANNELS,
        timeoutMs: this._env.TEST_AUDIO_LONGFORM_TIMEOUT_SEC * SECOND_MS,
      },
      chunkMs: this._env.TEST_AUDIO_CHUNK_MS,
      expectedSampleRate: this._env.TEST_AUDIO_SAMPLE_RATE,
      expectedChannels: this._env.TEST_AUDIO_CHANNELS,
    };
  }

  get deviceRunManagerConfig(): DeviceRunManagerConfig {
    const secret = this._env.TEST_AUDIO_DEVICE_SECRET;
    return {
      // Derived, not configured. An empty secret has to stay an empty token
      // rather than becoming `uid:<hmac of "">` — an HMAC keyed on the empty
      // string is a perfectly well-formed value that would make an
      // unprovisioned device report `configured: true` and then fail to
      // authenticate, which is the opposite of the inert default.
      deviceTokens: {
        good:
          secret === ''
            ? ''
            : deriveTestAudioDeviceToken(secret, TEST_AUDIO_DEVICE_UIDS.good),
        fault:
          secret === ''
            ? ''
            : deriveTestAudioDeviceToken(secret, TEST_AUDIO_DEVICE_UIDS.fault),
      },
      deviceAuth: {
        sessionManagerBaseUrl: this._env.SESSION_MANAGER_BASE_URL,
        timeoutMs: this._env.TEST_AUDIO_REQUEST_TIMEOUT_SEC * SECOND_MS,
      },
      stream: {
        nodeServerBaseUrl: this._env.NODE_SERVER_BASE_URL,
        upstreamWaitMs: this._env.TEST_AUDIO_UPSTREAM_WAIT_SEC * SECOND_MS,
      },
      maxDurationSec: this._env.TEST_AUDIO_MAX_DURATION_SEC,
      faultClip: this._env.TEST_AUDIO_FAULT_CLIP,
      rngSeed: this._env.TEST_AUDIO_RNG_SEED,
      roomRefreshMs: this._env.TEST_AUDIO_ROOM_REFRESH_SEC * SECOND_MS,
    };
  }

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path } : {},
      schema: CONFIG_SCHEMA,
    });
  }
}
