import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  SESSION_TOKEN_SIGNING_KEY: Type.String(),
  SESSION_MANAGER_BASE_URL: Type.String(),
  SESSION_MANAGER_SERVICE_API_KEY: Type.String(),
  TRANSCRIPTION_SERVICE_BASE_URL: Type.String(),
  TRANSCRIPTION_SERVICE_API_KEY: Type.String(),
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

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path } : {},
      schema: CONFIG_SCHEMA,
    });
  }
}
