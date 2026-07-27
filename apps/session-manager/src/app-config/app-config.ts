import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { DBClientConfig } from '#src/db/db-client.js';
import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';
import {
  DEFAULT_MATERIALIZATION_WORKER_CONFIG,
  type MaterializationWorkerConfig,
} from '#src/server/features/schedule-management/materialization.worker.js';
import type { AdminAuthConfig } from '#src/server/shared/services/admin-auth.service.js';
import type { DevicePresenceConfig } from '#src/server/shared/services/device-presence.service.js';
import type { ServiceAuthConfig } from '#src/server/shared/services/service-auth.service.js';
import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  ADMIN_API_KEY: Type.String(),
  SESSION_MANAGER_SERVICE_API_KEY: Type.String(),
  SESSION_TOKEN_SIGNING_KEY: Type.String(),
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),

  // Device presence (B1.6). The TTL must comfortably exceed the schedule long
  // poll cycle plus the write interval, or a healthy device flips offline
  // between two writes.
  DEVICE_LAST_SEEN_WRITE_INTERVAL_SEC: Type.Integer({
    minimum: 1,
    default: 60,
  }),
  DEVICE_ONLINE_TTL_SEC: Type.Integer({ minimum: 1, default: 180 }),

  // Demo caption room (see apps/node-server/PLAN-Demo-CAPTION_ROOM.md): seeds a
  // joinable, open-ended session so the webapps can be exercised end-to-end. On
  // by default in every environment (including production); set
  // DEMO_ROOM_ENABLED=false to turn it off. env-schema coerces the strings
  // "true"/"false" only - "1"/"0"/"" are rejected at boot.
  DEMO_ROOM_ENABLED: Type.Boolean({ default: true }),
  // Session UID the demo session is seeded with. Must match the Node Server's
  // DEMO_SESSION_UID; both services share the same built-in default, so neither
  // normally needs this set - override only if you change both.
  DEMO_SESSION_UID: Type.String({ default: DEFAULT_DEMO_SESSION_UID }),

  // Operator test-audio rooms (PLAN-TestAudioDevices). One shared secret, held
  // by this service and by the test-audio generator and by nothing else. This
  // service seeds two rooms and two source devices at fixed uids and stores
  // bcrypt(derive(secret, deviceUid)) as each device's credential; the generator
  // derives the same secret and authenticates with it. No token is ever copied
  // between them.
  //
  // Empty - the default - seeds NOTHING, which is exactly the inert state a
  // deployment that has not asked for this feature had before: the generator's
  // two devices report `configured: false` and refuse to start. Same shape as
  // DEMO_ROOM_ENABLED.
  //
  // Rotating it is a restart of both services: the stored hash is re-written
  // from the current value on every boot.
  TEST_AUDIO_DEVICE_SECRET: Type.String({ default: '' }),

  // Monitoring canary room (A2). Same scheme as TEST_AUDIO_DEVICE_SECRET above:
  // one shared secret, held by this service and by the monitoring sidecar and by
  // nothing else. This service seeds one room and one source device at fixed
  // uids and stores bcrypt(derive(secret, deviceUid)); the sidecar derives the
  // same secret and authenticates with it. It replaces
  // MONITORING_CANARY_DEVICE_TOKEN, which an operator provisioned by hand.
  //
  // A SEPARATE VARIABLE FROM TEST_AUDIO_DEVICE_SECRET, deliberately. Sharing one
  // would tie two unrelated on/off decisions together - arming the operator test
  // devices would also start an unattended canary probe every few minutes, and
  // retiring them would silently stop monitoring - and would hand a third
  // service the root key from which every synthetic device's credential is
  // derived, which is the independence the per-device HMAC exists to give.
  //
  // Empty - the default - seeds NOTHING and leaves the canary switched off,
  // which is where a deployment that never provisioned a canary device already
  // was. Rotating it is a restart of both services.
  CANARY_DEVICE_SECRET: Type.String({ default: '' }),
});

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

export interface DemoRoomConfig {
  /** When false, the demo room seeder is never constructed or run. */
  enabled: boolean;
  /** Session UID the seeded demo session is created with. */
  sessionUid: string;
}

export interface TestAudioRoomsConfig {
  /** When false, the test-audio seeder is never constructed or run. */
  enabled: boolean;
  /**
   * The deployment's `TEST_AUDIO_DEVICE_SECRET`. Each seeded device's stored
   * credential is `bcrypt(deriveTestAudioDeviceSecret(secret, deviceUid))`; the
   * generator derives the same value from the same two inputs.
   */
  deviceSecret: string;
}

export interface CanaryRoomConfig {
  /** When false, the canary room seeder is never constructed or run. */
  enabled: boolean;
  /**
   * The deployment's `CANARY_DEVICE_SECRET`. The seeded device's stored
   * credential is `bcrypt(deriveTestAudioDeviceSecret(secret, deviceUid))`; the
   * monitoring sidecar derives the same value from the same two inputs.
   */
  deviceSecret: string;
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

  get devicePresenceConfig(): DevicePresenceConfig {
    return {
      writeIntervalMs: this._env.DEVICE_LAST_SEEN_WRITE_INTERVAL_SEC * 1_000,
      onlineTtlMs: this._env.DEVICE_ONLINE_TTL_SEC * 1_000,
    };
  }

  get adminAuthConfig(): AdminAuthConfig {
    return {
      adminApiKey: this._env.ADMIN_API_KEY,
    };
  }

  get serviceAuthConfig(): ServiceAuthConfig {
    return {
      serviceApiKey: this._env.SESSION_MANAGER_SERVICE_API_KEY,
    };
  }

  get sessionTokenConfig(): SessionTokenConfig {
    return {
      signingKey: this._env.SESSION_TOKEN_SIGNING_KEY,
    };
  }

  get dbClientConfig(): DBClientConfig {
    return {
      dbHost: this._env.DB_HOST,
      dbPort: this._env.DB_PORT,
      dbName: this._env.DB_NAME,
      dbUser: this._env.DB_USER,
      dbPassword: this._env.DB_PASSWORD,
    };
  }

  get materializationWorkerConfig(): MaterializationWorkerConfig {
    return DEFAULT_MATERIALIZATION_WORKER_CONFIG;
  }

  get demoRoomConfig(): DemoRoomConfig {
    return {
      enabled: this._env.DEMO_ROOM_ENABLED,
      sessionUid: this._env.DEMO_SESSION_UID,
    };
  }

  get testAudioRoomsConfig(): TestAudioRoomsConfig {
    return {
      // Derived from the secret rather than being its own flag: there is
      // nothing to seed without one, and a separate TEST_AUDIO_ROOMS_ENABLED
      // would only add a way to be half-configured.
      enabled: this._env.TEST_AUDIO_DEVICE_SECRET !== '',
      deviceSecret: this._env.TEST_AUDIO_DEVICE_SECRET,
    };
  }

  get canaryRoomConfig(): CanaryRoomConfig {
    return {
      // Derived from the secret rather than being its own flag, for the same
      // reason as testAudioRoomsConfig: there is nothing to seed without one,
      // and a separate CANARY_ROOM_ENABLED would only add a way to be
      // half-configured.
      enabled: this._env.CANARY_DEVICE_SECRET !== '',
      deviceSecret: this._env.CANARY_DEVICE_SECRET,
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
