import envSchema from 'env-schema';
import { hostname } from 'node:os';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';
import type { ServiceAuthConfig } from '#src/server/shared/services/service-auth.service.js';
import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  NODE_SERVER_SERVICE_API_KEY: Type.String(),
  SESSION_TOKEN_SIGNING_KEY: Type.String(),
  SESSION_MANAGER_BASE_URL: Type.String(),
  SESSION_MANAGER_SERVICE_API_KEY: Type.String(),
  TRANSCRIPTION_SERVICE_BASE_URL: Type.String(),
  TRANSCRIPTION_SERVICE_API_KEY: Type.String(),
  // Defaulted, unlike everything above, because telemetry publishing is
  // optional: an unset URL means this instance simply does not publish, which
  // is what keeps a deployment that predates B1.7 booting unchanged.
  REDIS_URL: Type.String({ default: '' }),
  NODE_INSTANCE_ID: Type.String({ default: '' }),
  // Dev/staging-only demo caption room (see PLAN-Demo-CAPTION_ROOM.md). Off by
  // default so a production instance never emits synthetic captions; enabled
  // explicitly in the dev and staging deployments. env-schema coerces the
  // strings "true"/"false" only - "1"/"0"/"" are rejected at boot.
  DEMO_ROOM_ENABLED: Type.Boolean({ default: false }),
  // Session UID the demo captions are published for. Must match the session the
  // Session Manager seeds, so both services default to (and are configured
  // with) the same value.
  DEMO_SESSION_UID: Type.String({ default: DEFAULT_DEMO_SESSION_UID }),
});

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

export interface SessionManagerClientConfig {
  baseUrl: string;
  serviceApiKey: string;
}

export interface TranscriptionServiceClientConfig {
  baseUrl: string;
  apiKey: string;
}

export interface DemoRoomConfig {
  /** When false, the demo caption source is never constructed or started. */
  enabled: boolean;
  /** Session UID captions are published for; matches the seeded session. */
  sessionUid: string;
}

export interface TelemetryPublisherConfig {
  /** Empty when telemetry publishing is switched off. */
  redisUrl: string;
  /**
   * Identity this instance publishes under - a hostname or pod name, stable
   * across restarts. Part of the key it writes, and the value of the route key
   * that says which instance owns a session's upstream.
   */
  nodeInstanceId: string;
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

  /**
   * Inbound service-to-service auth. Deliberately a different secret from
   * `sessionManagerClientConfig.serviceApiKey`, which is presented outbound:
   * sharing one string would mean a compromise of an observability consumer
   * also grants Session Manager access.
   */
  get serviceAuthConfig(): ServiceAuthConfig {
    return {
      serviceApiKey: this._env.NODE_SERVER_SERVICE_API_KEY,
    };
  }

  get demoRoomConfig(): DemoRoomConfig {
    return {
      enabled: this._env.DEMO_ROOM_ENABLED,
      sessionUid: this._env.DEMO_SESSION_UID,
    };
  }

  get sessionTokenConfig(): SessionTokenConfig {
    return {
      signingKey: this._env.SESSION_TOKEN_SIGNING_KEY,
    };
  }

  get sessionManagerClientConfig(): SessionManagerClientConfig {
    return {
      baseUrl: this._env.SESSION_MANAGER_BASE_URL,
      serviceApiKey: this._env.SESSION_MANAGER_SERVICE_API_KEY,
    };
  }

  get transcriptionServiceClientConfig(): TranscriptionServiceClientConfig {
    return {
      baseUrl: this._env.TRANSCRIPTION_SERVICE_BASE_URL,
      apiKey: this._env.TRANSCRIPTION_SERVICE_API_KEY,
    };
  }

  /**
   * Fleet telemetry publishing (B1.7). Off unless `REDIS_URL` is set, so this
   * is opt-in per deployment and absent Redis is a configuration state rather
   * than an error.
   *
   * `NODE_INSTANCE_ID` defaults to the hostname, which under Docker and
   * Kubernetes is already the container or pod name - the identity an operator
   * reading the fleet view would name anyway. It is rejected here rather than
   * at each heartbeat if it could forge a key in another part of the telemetry
   * namespace, so a bad value fails at boot instead of quietly writing where a
   * reader will not look for it.
   */
  get telemetryPublisherConfig(): TelemetryPublisherConfig {
    const nodeInstanceId = this._env.NODE_INSTANCE_ID || hostname();
    if (nodeInstanceId.includes(':') || nodeInstanceId === '') {
      throw new Error(
        `NODE_INSTANCE_ID must be non-empty and must not contain ':' (got '${nodeInstanceId}')`,
      );
    }
    return {
      redisUrl: this._env.REDIS_URL,
      nodeInstanceId,
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
