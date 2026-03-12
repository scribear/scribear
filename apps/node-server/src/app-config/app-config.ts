import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { JwtServiceConfig } from '#src/server/features/session-streaming/jwt.service.js';

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  JWT_SECRET: Type.String({ minLength: 32 }),
  TRANSCRIPTION_SERVICE_ADDRESS: Type.String(),
  TRANSCRIPTION_SERVICE_API_KEY: Type.String(),
});

/**
 * Class that loads and provides application configuration
 */
class AppConfig {
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

  get jwtServiceConfig(): JwtServiceConfig {
    return {
      jwtSecret: this._env.JWT_SECRET,
    };
  }

  get transcriptionConfig(): { address: string; apiKey: string } {
    return {
      address: this._env.TRANSCRIPTION_SERVICE_ADDRESS,
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

export default AppConfig;
