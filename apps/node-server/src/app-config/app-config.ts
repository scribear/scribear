import envSchema from 'env-schema';
import { hostname } from 'node:os';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';
import type { SecretPlaceholders } from '@scribear/node-server-schema';

import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';
import type { ServiceAuthConfig } from '#src/server/shared/services/service-auth.service.js';
import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';
import { isPlaceholderSecret } from '#src/server/utils/constant-time-equal.js';

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
  // Demo caption room (see PLAN-Demo-CAPTION_ROOM.md): emits a looping,
  // synthetic caption stream that needs no microphone, source device, or
  // transcription-service. On by default in every environment (including
  // production) so the webapps always have something to show; set
  // DEMO_ROOM_ENABLED=false to turn it off. env-schema coerces the strings
  // "true"/"false" only - "1"/"0"/"" are rejected at boot.
  DEMO_ROOM_ENABLED: Type.Boolean({ default: true }),
  // Session UID the demo captions are published for. Must match the session the
  // Session Manager seeds; both services share the same built-in default, so
  // neither normally needs this set - override only if you change both.
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
   * Classifies each secret this process holds without ever exposing its
   * value (PLAN-ConfigCheck-Coverage Phase 2) — reported on `GET /status`,
   * the endpoint the monitoring sidecar already polls, and from there relayed
   * to Config Check on the Admin Server.
   *
   * Uses `isPlaceholderSecret`, not a local restatement of the `CHANGEME`
   * substring match: `config-check.service.ts` on the Admin Server *does*
   * restate this check for its own secrets rather than importing this
   * service's copy, and that cross-service duplication is deliberate (see
   * e.g. transcription-service's Python side restating the status schema
   * rather than importing it) — but `isPlaceholderSecret` is already this
   * service's one definition of "unusable", the same one
   * `assertNotPlaceholderKey` builds its boot guard on, and reusing it here
   * keeps that true instead of growing a second, driftable copy inside this
   * file.
   *
   * `isPlaceholderSecret` treats an empty string as a placeholder too, so an
   * unset secret is flagged the same as one still reading `CHANGEME`. That is
   * deliberately not the same distinction the Admin Server's own
   * `describeSecret`/`admin-session-secret-missing` draws between "not set"
   * and "placeholder": that distinction exists there because
   * `ADMIN_SESSION_SECRET` has a fallback — unset, it signs cookies with a
   * random secret minted per boot, a materially different failure with a
   * different remediation than a known, public secret. None of the four
   * secrets classified here have any such fallback: each is used directly, as
   * an HMAC key or a presented bearer credential, so empty and `CHANGEME` are
   * equally guessable and share one remediation ("set a real high-entropy
   * secret"). Collapsing them into one flag per secret is what that equal
   * consequence justifies.
   *
   * One of the four is additionally unobservable as "empty" here in
   * practice: `NODE_SERVER_SERVICE_API_KEY`'s `ServiceAuthService` constructor
   * calls `assertNotPlaceholderKey`, which throws for both empty and
   * `CHANGEME`, and it is resolved from the DI container inside
   * `serviceApiKeyHook` on every request that requires the service key —
   * including `/status` itself. That is a fail-closed *guard*, not a
   * boot-time check: this process starts fine either way, and the throw
   * happens on the first request that needs the key. So a deployment with
   * that one key empty or placeholder fails every service-key-guarded
   * request rather than ever reaching this getter with a false-green answer.
   */
  get secretPlaceholders(): SecretPlaceholders {
    return {
      sessionTokenSigningKeyIsPlaceholder: isPlaceholderSecret(
        this._env.SESSION_TOKEN_SIGNING_KEY,
      ),
      sessionManagerServiceApiKeyIsPlaceholder: isPlaceholderSecret(
        this._env.SESSION_MANAGER_SERVICE_API_KEY,
      ),
      nodeServerServiceApiKeyIsPlaceholder: isPlaceholderSecret(
        this._env.NODE_SERVER_SERVICE_API_KEY,
      ),
      transcriptionServiceApiKeyIsPlaceholder: isPlaceholderSecret(
        this._env.TRANSCRIPTION_SERVICE_API_KEY,
      ),
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
