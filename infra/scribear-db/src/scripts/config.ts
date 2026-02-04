import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

const CONFIG_SCHEMA = Type.Object({
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
});

/**
 * Class that loads and provides database configuration for scripts
 */
class DatabaseConfig {
  private _host: string;
  private _port: number;
  private _database: string;
  private _user: string;
  private _password: string;

  get host() {
    return this._host;
  }

  get port() {
    return this._port;
  }

  get database() {
    return this._database;
  }

  get user() {
    return this._user;
  }

  get password() {
    return this._password;
  }

  constructor(path?: string) {
    const env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path, quiet: true } : { quiet: true },
      schema: CONFIG_SCHEMA,
    });

    this._host = env.DB_HOST;
    this._port = env.DB_PORT;
    this._database = env.DB_NAME;
    this._user = env.DB_USER;
    this._password = env.DB_PASSWORD;
  }
}

export default DatabaseConfig;
