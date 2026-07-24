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

  // Dev/staging-only demo caption room (see
  // apps/node-server/PLAN-Demo-CAPTION_ROOM.md). Off by default so a
  // production instance never seeds a real, joinable session; enabled
  // explicitly in the dev and staging deployments. env-schema coerces the
  // strings "true"/"false" only - "1"/"0"/"" are rejected at boot.
  DEMO_ROOM_ENABLED: Type.Boolean({ default: false }),
  // Session UID the demo session is seeded with. Must match the Node
  // Server's DEMO_SESSION_UID, so both services default to (and are
  // configured with) the same value.
  DEMO_SESSION_UID: Type.String({ default: DEFAULT_DEMO_SESSION_UID }),
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

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path } : {},
      schema: CONFIG_SCHEMA,
    });
  }
}
