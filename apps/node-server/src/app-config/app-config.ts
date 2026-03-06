import envSchema from 'env-schema';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { LogLevel } from '@scribear/base-fastify-server';

export interface BaseConfig {
    isDevelopment: boolean;
    logLevel: LogLevel;
    port: number;
    host: string;
}

export interface TranscriptionConfig {
    transcriptionServiceUrl: string;
    transcriptionApiKey: string;
}

const CONFIG_SCHEMA = Type.Object({
    LOG_LEVEL: Type.Enum(LogLevel),
    PORT: Type.Integer({ minimum: 0, maximum: 65_535 }),
    HOST: Type.String(),
    JWT_SECRET: Type.String({ minLength: 32 }),
    JWT_ISSUER: Type.String({ default: 'scribear-session-manager' }),
    TRANSCRIPTION_SERVICE_URL: Type.String(),
    TRANSCRIPTION_API_KEY: Type.String(),
    SESSION_MANAGER_URL: Type.String(),
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

    get jwtSecret(): string {
        return this._env.JWT_SECRET;
    }

    get jwtIssuer(): string {
        return this._env.JWT_ISSUER;
    }

    get transcriptionConfig(): TranscriptionConfig {
        return {
            transcriptionServiceUrl: this._env.TRANSCRIPTION_SERVICE_URL,
            transcriptionApiKey: this._env.TRANSCRIPTION_API_KEY,
        };
    }

    get sessionManagerUrl(): string {
        return this._env.SESSION_MANAGER_URL;
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
