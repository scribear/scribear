import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { AdminDbClientConfig } from '#src/db/admin-db-client.js';
import type { HealthCheckerConfig } from '#src/server/features/health/health.service.js';
import type { RateLimitConfig } from '#src/server/plugins/rate-limit.plugin.js';
import type { AzureAuthConfig } from '#src/server/shared/services/azure-oidc-auth.service.js';
import type { LocalAuthConfig } from '#src/server/shared/services/local-auth.service.js';
import type { SessionManagerGatewayConfig } from '#src/server/shared/services/session-manager-gateway.service.js';
import type { SessionConfig } from '#src/server/shared/services/session.service.js';

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),

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

  // Session cookie signing + lifetimes
  ADMIN_SESSION_SECRET: Type.String({ minLength: 32 }),
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

  /** Secret used by `@fastify/cookie` to sign the session cookie. */
  get cookieSecret(): string {
    return this._env.ADMIN_SESSION_SECRET;
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
