import envSchema from 'env-schema';
import { randomBytes } from 'node:crypto';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { BUILD_INFO_PATH, LogLevel } from '@scribear/base-fastify-server';

import type { AdminDbClientConfig } from '#src/db/admin-db-client.js';
import type { ConfigCheckConfig } from '#src/server/features/config-check/config-check.service.js';
import type { DeploymentVersionsConfig } from '#src/server/features/deployment-versions/deployment-versions.service.js';
import type { HealthCheckerConfig } from '#src/server/features/health/health.service.js';
import type { TestAudioConfig } from '#src/server/features/test-audio/test-audio-gateway.service.js';
import type { RateLimitConfig } from '#src/server/plugins/rate-limit.plugin.js';
import type { AzureAuthConfig } from '#src/server/shared/services/azure-oidc-auth.service.js';
import type { FleetTelemetryConfig } from '#src/server/shared/services/fleet-telemetry.service.js';
import type { LocalAuthConfig } from '#src/server/shared/services/local-auth.service.js';
import type { SessionManagerGatewayConfig } from '#src/server/shared/services/session-manager-gateway.service.js';
import type { SessionConfig } from '#src/server/shared/services/session.service.js';

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

/**
 * Where the nginx-served containers keep their build document.
 *
 * `BUILD_INFO_PATH` plus a `.json` extension, so that nginx serves it with the
 * right content type off its default mime map and no per-image config.
 */
const BUILD_INFO_FILE = `${BUILD_INFO_PATH}.json`;

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

  // Which `deployment/compose.yml` is running this stack. Set as a literal in
  // that file rather than interpolated from .env, so it describes the file
  // itself; Deployment Check compares it against the `EXPECTED_COMPOSE_FILE_
  // VERSION` baked into this image.
  //
  // Optional, and a plain string rather than an integer, for the same reason
  // DEPLOYMENT_ENV above is: absent means the running compose file predates
  // this check, which is a finding to report and not a reason to refuse to
  // boot — and a deployment whose compose file is out of date is exactly the
  // one that must still start so an operator can read the console and find
  // out why.
  COMPOSE_FILE_VERSION: Type.String({ default: '' }),

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

  // Deployment Check's per-container version table. In-cluster base URLs of the
  // containers the health rollup does not already name, reached only for their
  // unauthenticated build documents.
  //
  // All defaulted to their compose service names, unlike the two above: these
  // exist so an unusual deployment *can* redirect them, not because anyone has
  // to set them. A deployment that renames a service overrides the one URL
  // rather than gaining a required variable, and an .env written before this
  // release needs no edit at all.
  MONITORING_SIDECAR_BASE_URL: Type.String({
    default: 'http://monitoring-sidecar:80',
  }),
  CLIENT_WEBAPP_BASE_URL: Type.String({ default: 'http://client-webapp:80' }),
  STANDALONE_WEBAPP_BASE_URL: Type.String({
    default: 'http://standalone-webapp:80',
  }),
  KIOSK_WEBAPP_BASE_URL: Type.String({ default: 'http://kiosk-webapp:80' }),
  ADMIN_WEBAPP_BASE_URL: Type.String({ default: 'http://admin-webapp:80' }),
  // Plain HTTP, and port 80 specifically: the proxy answers its build document
  // only on its unencrypted listener, so that publishing it on 443 does not put
  // the deployment's commit hash on the public web. See infra/scribear-nginx.
  NGINX_BASE_URL: Type.String({ default: 'http://nginx:80' }),

  // Fleet telemetry backplane (B1.7 §2.5). Defaulted, unlike the URLs above:
  // an unset value means this deployment predates B1.7 or has not opted in,
  // and /fleet answers 503 rather than the BFF failing to boot.
  REDIS_URL: Type.String({ default: '' }),

  // Operator test-audio devices (PLAN-TestAudioDevices §3). Empty base URL is
  // the default and means the feature is off: the panel reads
  // `{ available: false, devices: [] }` at 200 and every mutation 503s, the
  // same "unprovisioned is a state, not a failure" shape REDIS_URL above uses.
  // Most deployments never provision these, so requiring either variable would
  // stop them booting over a diagnostic tool they do not run.
  TEST_AUDIO_BASE_URL: Type.String({ default: '' }),
  // The generator's service key. Held here and injected server-side, exactly
  // like ADMIN_API_KEY — it never reaches the browser.
  TEST_AUDIO_SERVICE_KEY: Type.String({ default: '' }),

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
   * Which container to ask for its build, and where its build document lives.
   *
   * admin-server is absent deliberately — the service reads its own in-process
   * rather than making a request to itself.
   *
   * The path differs by container kind and that is not incidental: the Node
   * services and transcription-service serve `/build-info` from a route, while
   * the webapps and the proxy are nginx serving a static `build-info.json`
   * generated at image build time. One path would have meant one of those two
   * groups doing something unnatural.
   */
  get deploymentVersionsConfig(): DeploymentVersionsConfig {
    return {
      // Shared with the health rollup: both ask sibling containers a question
      // an operator is waiting on, so one knob should bound both.
      timeoutMs: this._env.HEALTH_CHECK_TIMEOUT_SEC * SECOND_MS,
      // Passed through raw. The service decides what an unset or unparseable
      // value means, so that this getter stays a description of the
      // environment rather than a second place the rule lives.
      reportedComposeFileVersion: this._env.COMPOSE_FILE_VERSION,
      targets: [
        {
          name: 'session-manager',
          url: `${this._env.SESSION_MANAGER_BASE_URL}${BUILD_INFO_PATH}`,
        },
        {
          name: 'node-server',
          url: `${this._env.NODE_SERVER_BASE_URL}${BUILD_INFO_PATH}`,
        },
        {
          name: 'transcription-service',
          url: `${this._env.TRANSCRIPTION_SERVICE_BASE_URL}${BUILD_INFO_PATH}`,
        },
        {
          name: 'monitoring-sidecar',
          url: `${this._env.MONITORING_SIDECAR_BASE_URL}${BUILD_INFO_PATH}`,
        },
        {
          name: 'client-webapp',
          url: `${this._env.CLIENT_WEBAPP_BASE_URL}${BUILD_INFO_FILE}`,
        },
        {
          name: 'standalone-webapp',
          url: `${this._env.STANDALONE_WEBAPP_BASE_URL}${BUILD_INFO_FILE}`,
        },
        {
          name: 'kiosk-webapp',
          url: `${this._env.KIOSK_WEBAPP_BASE_URL}${BUILD_INFO_FILE}`,
        },
        {
          name: 'admin-webapp',
          url: `${this._env.ADMIN_WEBAPP_BASE_URL}${BUILD_INFO_FILE}`,
        },
        {
          name: 'nginx',
          url: `${this._env.NGINX_BASE_URL}${BUILD_INFO_FILE}`,
        },
        {
          name: 'test-audio-generator',
          url: `${this._env.TEST_AUDIO_BASE_URL}${BUILD_INFO_PATH}`,
        },
      ],
      // Listed rather than omitted. An operator scanning this table for what is
      // deployed needs to see every container in compose.yml, and a service
      // that is simply absent reads as an oversight; a service that says why it
      // is blank does not. Both are stock upstream images with a thin wrapper,
      // and neither speaks a protocol this console could ask the question in.
      nonReporting: [
        {
          name: 'scribear-db',
          detail:
            'Postgres has no HTTP surface to report a build on. Its version moves with IMAGE_TAG like every other image — check it with `docker compose images scribear-db`.',
        },
        {
          name: 'redis',
          detail:
            'Redis has no HTTP surface to report a build on. Its version moves with IMAGE_TAG like every other image — check it with `docker compose images redis`.',
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
   * Operator test-audio devices (PLAN-TestAudioDevices §3). Off unless
   * `TEST_AUDIO_BASE_URL` is set — `TestAudioGatewayService` opens no
   * connection and every mutation answers 503 `TEST_AUDIO_UNAVAILABLE` when it
   * is empty, the same disabled-by-default shape as `fleetTelemetryConfig`.
   */
  get testAudioConfig(): TestAudioConfig {
    return {
      baseUrl: this._env.TEST_AUDIO_BASE_URL,
      serviceKey: this._env.TEST_AUDIO_SERVICE_KEY,
      // Shared with the health rollup deliberately, like the Config Check's
      // own timeout: both ask a sibling container a question an operator is
      // waiting on, so one knob should bound both.
      timeoutMs: this._env.HEALTH_CHECK_TIMEOUT_SEC * SECOND_MS,
    };
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
