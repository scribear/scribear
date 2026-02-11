import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

import type { DBClientConfig } from '#src/db/db-client.js';
import type { AuthServiceConfig } from '#src/server/services/auth.service.js';
import type { HashServiceConfig } from '#src/server/services/hash.service.js';
import type { JwtServiceConfig } from '#src/server/services/jwt.service.js';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  JWT_SECRET: Type.String({ minLength: 32 }),
  JWT_ISSUER: Type.String({ default: 'scribear-session-manager' }),
  JWT_EXPIRES_IN: Type.String({ default: '24h' }),
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  HASH_SALT_ROUNDS: Type.Number({ minimum: 10, default: '10' }),
  API_KEY: Type.String({ minLength: 1 }),
});

export interface BaseConfig {
  isDevelopment: boolean;
  logLevel: LogLevel;
  port: number;
  host: string;
}

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

  get dbClientConfig(): DBClientConfig {
    return {
      dbHost: this._env.DB_HOST,
      dbPort: this._env.DB_PORT,
      dbName: this._env.DB_NAME,
      dbUser: this._env.DB_USER,
      dbPassword: this._env.DB_PASSWORD,
    };
  }

  get jwtServiceConfig(): JwtServiceConfig {
    return {
      jwtSecret: this._env.JWT_SECRET,
      jwtIssuer: this._env.JWT_ISSUER,
      jwtExpiresIn: this._env.JWT_EXPIRES_IN,
    };
  }

  get hashServiceConfig(): HashServiceConfig {
    return {
      saltRounds: this._env.HASH_SALT_ROUNDS,
    };
  }

  get authServiceConfig(): AuthServiceConfig {
    return {
      apiKey: this._env.API_KEY,
    };
  }

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path, quiet: true } : { quiet: true },
      schema: CONFIG_SCHEMA,
    });
  }
}

export default AppConfig;
