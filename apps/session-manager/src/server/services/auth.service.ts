import type { AppDependencies } from '../dependency-injection/register-dependencies.js';

export interface AuthServiceConfig {
  apiKey: string;
}

export class AuthService {
  private _config: AuthServiceConfig;

  constructor(authServiceConfig: AppDependencies['authServiceConfig']) {
    this._config = authServiceConfig;
  }

  validateApiKey(key: string): boolean {
    return key === this._config.apiKey;
  }
}
