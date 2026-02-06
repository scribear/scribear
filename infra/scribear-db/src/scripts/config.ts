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
  private _env: Static<typeof CONFIG_SCHEMA>;

  get host() {
    return this._env.DB_HOST;
  }

  get port() {
    return this._env.DB_PORT;
  }

  get database() {
    return this._env.DB_NAME;
  }

  get user() {
    return this._env.DB_USER;
  }

  get password() {
    return this._env.DB_PASSWORD;
  }

  constructor(path?: string) {
    this._env = envSchema<Static<typeof CONFIG_SCHEMA>>({
      dotenv: path ? { path, quiet: true } : { quiet: true },
      schema: CONFIG_SCHEMA,
    });
  }
}

export default DatabaseConfig;
