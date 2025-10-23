import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
  JWT_SECRET: Type.String({ minLength: 32 }),
  JWT_ISSUER: Type.Optional(Type.String()),
  JWT_EXPIRES_IN: Type.Optional(Type.String()),
});

/**
 * Class that loads and provides application configuration
 */
class AppConfig {
  private _isDevelopment: boolean;
  private _logLevel: LogLevel;
  private _port: number;
  private _host: string;
  private _jwtSecret: string;
  private _jwtIssuer: string;
  private _jwtExpiresIn: string;

  get isDevelopment() {
    return this._isDevelopment;
  }

  get logLevel() {
    return this._logLevel;
  }

  get port() {
    return this._port;
  }

  get host() {
    return this._host;
  }

  get jwtSecret() {
    return this._jwtSecret;
  }

  get jwtIssuer() {
    return this._jwtIssuer;
  }

  get jwtExpiresIn() {
    return this._jwtExpiresIn;
  }

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    const env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path, quiet: true } : { quiet: true },
      schema: CONFIG_SCHEMA,
    });

    this._logLevel = env.LOG_LEVEL;
    this._port = env.PORT;
    this._host = env.HOST;
    this._jwtSecret = env.JWT_SECRET;
    this._jwtIssuer = env.JWT_ISSUER ?? 'scribear-session-manager';
    this._jwtExpiresIn = env.JWT_EXPIRES_IN ?? '24h';
  }
}

export default AppConfig;
