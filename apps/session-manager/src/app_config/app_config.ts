import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

const CONFIG_SCHEMA = Type.Object({
  LOG_LEVEL: Type.Enum(LogLevel),
  PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  HOST: Type.String(),
});

/**
 * Class that loads and provides application configuration
 */
class AppConfig {
  private _isDevelopment: boolean;
  private _logLevel: LogLevel;
  private _port: number;
  private _host: string;

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

  constructor(path?: string) {
    this._isDevelopment = process.argv.includes('--dev');

    const env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path, quiet: true } : { quiet: true },
      schema: CONFIG_SCHEMA,
    });

    this._logLevel = env.LOG_LEVEL;
    this._port = env.PORT;
    this._host = env.HOST;
  }
}

export default AppConfig;
