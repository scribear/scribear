import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { DBClientConfig } from '#src/db/db-client.js';
import {
  DEFAULT_MATERIALIZATION_WORKER_CONFIG,
  type MaterializationWorkerConfig,
} from '#src/server/features/schedule-management/materialization.worker.js';
import type { AdminAuthConfig } from '#src/server/shared/services/admin-auth.service.js';
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

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path } : {},
      schema: CONFIG_SCHEMA,
    });
  }
}
