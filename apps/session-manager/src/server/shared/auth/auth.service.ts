import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

export interface AuthServiceConfig {
  apiKey: string;
}

export class AuthService {
  private _config: AuthServiceConfig;
  private _hashService: AppDependencies['hashService'];
  private _authRepository: AppDependencies['authRepository'];

  constructor(
    authServiceConfig: AppDependencies['authServiceConfig'],
    hashService: AppDependencies['hashService'],
    authRepository: AppDependencies['authRepository'],
  ) {
    this._config = authServiceConfig;
    this._hashService = hashService;
    this._authRepository = authRepository;
  }

  validateApiKey(key: string): boolean {
    return key === this._config.apiKey;
  }

  async validateKioskToken(token: string): Promise<boolean> {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');

    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return false;
    }

    const kioskId = decoded.substring(0, separatorIndex);
    const secret = decoded.substring(separatorIndex + 1);

    if (!kioskId || !secret) {
      return false;
    }

    const kiosk = await this._authRepository.findKioskSecretHash(kioskId);
    if (!kiosk) {
      return false;
    }

    return await this._hashService.compareHash(secret, kiosk.secret_hash);
  }
}
