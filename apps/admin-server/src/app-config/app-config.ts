import envSchema from 'env-schema';
import { randomBytes } from 'node:crypto';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { AdminDbClientConfig } from '#src/db/admin-db-client.js';
import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import type { HealthCheckerConfig } from '#src/server/features/health/health.service.js';
import type { RateLimitConfig } from '#src/server/plugins/rate-limit.plugin.js';
import type { AzureAuthConfig } from '#src/server/shared/services/azure-oidc-auth.service.js';
import type { FleetTelemetryConfig } from '#src/server/shared/services/fleet-telemetry.service.js';
import type { LocalAuthConfig } from '#src/server/shared/services/local-auth.service.js';
import type { SessionManagerGatewayConfig } from '#src/server/shared/services/session-manager-gateway.service.js';
import type { SessionConfig } from '#src/server/shared/services/session.service.js';

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),

  // Which standard the Config Check judges this deployment against:
  // development, staging or production. Deliberately a plain string with an
  // empty default rather than an enum, so that adding it cannot stop an
  // existing deployment from booting and a typo is reported by the check
  // itself instead of by a boot failure. Unset infers production unless the
  // server was started with --dev; see `resolveEnvironment` for why the
  // asymmetry is the safe direction.
  DEPLOYMENT_ENV: Type.String({ default: '' }),

  // Session Manager gateway
  ADMIN_API_KEY: Type.String({ minLength: 1 }),
  SESSION_MANAGER_BASE_URL: Type.String({ minLength: 1 }),

  // Health rollup (B1.5). In-cluster base URLs of the services the admin
  // console reports on; only their unauthenticated readiness probes are read.
  NODE_SERVER_BASE_URL: Type.String({ default: 'http://node-server:80' }),
  TRANSCRIPTION_SERVICE_BASE_URL: Type.String({
    default: 'http://transcription-service:80',
  }),
  // Per-component, and the components are checked concurrently, so this is
  // also the worst case for the whole rollup. Kept short: an admin is waiting.
  HEALTH_CHECK_TIMEOUT_SEC: Type.Integer({ minimum: 1, default: 3 }),

  // Fleet telemetry backplane (B1.7 §2.5). Defaulted, unlike the URLs above:
  // an unset value means this deployment predates B1.7 or has not opted in,
  // and /fleet answers 503 rather than the BFF failing to boot.
  REDIS_URL: Type.String({ default: '' }),

  // Session cookie signing + lifetimes. Deliberately a plain string with an
  // empty default rather than `minLength: 32`: a boot-time length rule would
  // refuse to start over a weak secret, which is the opposite of this codebase's
  // approach (see DEPLOYMENT_ENV above). The 32-character strength requirement
  // is enforced by the Config Check instead — `admin-session-secret-missing` /
  // `admin-session-secret-weak` — so a too-short secret is reported, not fatal.
  ADMIN_SESSION_SECRET: Type.String({ default: '' }),
  ADMIN_SESSION_IDLE_TIMEOUT_MINUTES: Type.Integer({
    minimum: 1,
    default: 60,
  }),
  ADMIN_SESSION_ABSOLUTE_TIMEOUT_MINUTES: Type.Integer({
    minimum: 1,
    default: 480,
  }),

  // Local staff account ("<username> <password>"); empty disables local login.
  ADMIN_LOCAL_CREDENTIALS: Type.String({ default: '' }),

  // Rate limiting
  ADMIN_RATE_LIMIT_GLOBAL_MAX: Type.Integer({ minimum: 1, default: 300 }),
  ADMIN_RATE_LIMIT_GLOBAL_WINDOW_SEC: Type.Integer({ minimum: 1, default: 60 }),
  ADMIN_RATE_LIMIT_LOGIN_MAX: Type.Integer({ minimum: 1, default: 5 }),
  ADMIN_RATE_LIMIT_LOGIN_WINDOW_SEC: Type.Integer({ minimum: 1, default: 60 }),

  // Database (admin audit log)
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),

  // Future Azure Entra ID SSO. Presence enables the provider; empty = disabled.
  AZURE_TENANT_ID: Type.String({ default: '' }),
  AZURE_CLIENT_ID: Type.String({ default: '' }),
  AZURE_CLIENT_SECRET: Type.String({ default: '' }),
  AZURE_REDIRECT_URI: Type.String({ default: '' }),
  ADMIN_ALLOWED_GROUP: Type.String({ default: '' }),
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
  /**
   * Fallback cookie-signing secret, minted once per process. Used only when
   * `ADMIN_SESSION_SECRET` is unset — see `cookieSecret`.
   */
  private _ephemeralCookieSecret = randomBytes(32).toString('hex');

  get baseConfig(): BaseConfig {
    return {
      isDevelopment: this._isDevelopment,
      logLevel: this._env.LOG_LEVEL,
      port: this._env.PORT,
      host: this._env.HOST,
    };
  }

  get healthCheckerConfig(): HealthCheckerConfig {
    return {
      timeoutMs: this._env.HEALTH_CHECK_TIMEOUT_SEC * SECOND_MS,
      targets: [
        {
          name: 'session-manager',
          readinessUrl: `${this._env.SESSION_MANAGER_BASE_URL}/api/session-manager/v1/probes/readiness`,
        },
        {
          name: 'node-server',
          readinessUrl: `${this._env.NODE_SERVER_BASE_URL}/api/node-server/v1/probes/readiness`,
        },
        {
          // transcription-service mounts its probes at the root, with no
          // /api/<service>/v1 prefix, unlike every Node service.
          name: 'transcription-service',
          readinessUrl: `${this._env.TRANSCRIPTION_SERVICE_BASE_URL}/probes/readiness`,
        },
      ],
    };
  }

  /**
   * Fleet telemetry backplane (B1.7 §2.5). Off unless `REDIS_URL` is set —
   * `FleetTelemetryService` opens no connection and `/fleet` answers 503
   * `TELEMETRY_UNAVAILABLE` when it is empty.
   */
  get fleetTelemetryConfig(): FleetTelemetryConfig {
    return { redisUrl: this._env.REDIS_URL };
  }

  /**
   * Inputs for the Config Check (admin console → Config Check).
   *
   * Secret values are handed over because classifying them requires them; the
   * service turns each into a classification and never returns one. Gathered
   * here so that `ConfigCheckService` reads no environment of its own and can
   * be constructed directly in tests.
   */
  get configCheckConfig(): ConfigCheckConfig {
    return {
      declaredEnv: this._env.DEPLOYMENT_ENV,
      isDevelopment: this._isDevelopment,
      adminApiKey: this._env.ADMIN_API_KEY,
      adminSessionSecret: this._env.ADMIN_SESSION_SECRET,
      adminLocalCredentials: this._env.ADMIN_LOCAL_CREDENTIALS,
      dbHost: this._env.DB_HOST,
      dbName: this._env.DB_NAME,
      dbUser: this._env.DB_USER,
      dbPassword: this._env.DB_PASSWORD,
      redisUrl: this._env.REDIS_URL,
      azureTenantId: this._env.AZURE_TENANT_ID,
      azureClientId: this._env.AZURE_CLIENT_ID,
      azureClientSecret: this._env.AZURE_CLIENT_SECRET,
      allowedGroup: this._env.ADMIN_ALLOWED_GROUP,
      // Shared with the health rollup deliberately: both ask a sibling service a
      // question an operator is waiting on, so one knob should bound both.
      upstreamTimeoutMs: this._env.HEALTH_CHECK_TIMEOUT_SEC * SECOND_MS,
    };
  }

  get sessionManagerGatewayConfig(): SessionManagerGatewayConfig {
    return {
      adminApiKey: this._env.ADMIN_API_KEY,
      sessionManagerBaseUrl: this._env.SESSION_MANAGER_BASE_URL,
    };
  }

  get sessionConfig(): SessionConfig {
    return {
      // In development the cookie must not be `Secure` or it won't be sent over
      // plain HTTP; in production it always is (nginx terminates TLS).
      secure: !this._isDevelopment,
      idleTimeoutMs: this._env.ADMIN_SESSION_IDLE_TIMEOUT_MINUTES * MINUTE_MS,
      absoluteTimeoutMs:
        this._env.ADMIN_SESSION_ABSOLUTE_TIMEOUT_MINUTES * MINUTE_MS,
    };
  }

  /**
   * Secret used by `@fastify/cookie` to sign the session cookie.
   *
   * Falls back to a per-process random secret when `ADMIN_SESSION_SECRET` is
   * unset, so a missing secret degrades to "sessions don't survive a restart"
   * — already true of the in-memory session store — and is surfaced by the
   * Config Check, rather than making `@fastify/cookie` throw the first time a
   * signed cookie is set and taking the admin console down with it. A
   * configured secret is used verbatim; its strength is graded by the Config
   * Check, not enforced here.
   */
  get cookieSecret(): string {
    return this._env.ADMIN_SESSION_SECRET || this._ephemeralCookieSecret;
  }

  get localAuthConfig(): LocalAuthConfig {
    return {
      credentials: this._env.ADMIN_LOCAL_CREDENTIALS,
    };
  }

  get azureAuthConfig(): AzureAuthConfig {
    return {
      tenantId: this._env.AZURE_TENANT_ID,
      clientId: this._env.AZURE_CLIENT_ID,
      clientSecret: this._env.AZURE_CLIENT_SECRET,
      redirectUri: this._env.AZURE_REDIRECT_URI,
      allowedGroup: this._env.ADMIN_ALLOWED_GROUP,
    };
  }

  get rateLimitConfig(): RateLimitConfig {
    return {
      globalMax: this._env.ADMIN_RATE_LIMIT_GLOBAL_MAX,
      globalWindowMs: this._env.ADMIN_RATE_LIMIT_GLOBAL_WINDOW_SEC * SECOND_MS,
      loginMax: this._env.ADMIN_RATE_LIMIT_LOGIN_MAX,
      loginWindowMs: this._env.ADMIN_RATE_LIMIT_LOGIN_WINDOW_SEC * SECOND_MS,
    };
  }

  get dbClientConfig(): AdminDbClientConfig {
    return {
      dbHost: this._env.DB_HOST,
      dbPort: this._env.DB_PORT,
      dbName: this._env.DB_NAME,
      dbUser: this._env.DB_USER,
      dbPassword: this._env.DB_PASSWORD,
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
