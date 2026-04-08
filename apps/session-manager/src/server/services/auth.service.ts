import type { AppDependencies } from '../dependency-injection/register-dependencies.js';

const BEARER_PREFIX = 'Bearer ';
const DEVICE_TOKEN_SEPARATOR = ':';

export interface AuthServiceConfig {
  apiKey: string;
  nodeServerKey: string;
}

export class AuthService {
  private _log: AppDependencies['logger'];
  private _authServiceConfig: AppDependencies['authServiceConfig'];
  private _authRepository: AppDependencies['authRepository'];
  private _hashService: AppDependencies['hashService'];

  constructor(
    logger: AppDependencies['logger'],
    authServiceConfig: AppDependencies['authServiceConfig'],
    authRepository: AppDependencies['authRepository'],
    hashService: AppDependencies['hashService'],
  ) {
    this._log = logger;
    this._authServiceConfig = authServiceConfig;
    this._authRepository = authRepository;
    this._hashService = hashService;
  }

  isValidApiKey(authorizationHeader: string | undefined) {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;

    const key = authorizationHeader.slice(BEARER_PREFIX.length);
    return key === this._authServiceConfig.apiKey;
  }

  isValidNodeServerKey(authorizationHeader: string | undefined) {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;

    const key = authorizationHeader.slice(BEARER_PREFIX.length);
    return key === this._authServiceConfig.nodeServerKey;
  }

  encodeDeviceToken(deviceId: string, secret: string) {
    return `${deviceId}${DEVICE_TOKEN_SEPARATOR}${secret}`;
  }

  decodeDeviceToken(token: string) {
    const separatorIndex = token.indexOf(DEVICE_TOKEN_SEPARATOR);
    if (separatorIndex === -1) {
      this._log.info('Device token missing separator');
      return null;
    }
    return {
      deviceId: token.slice(0, separatorIndex),
      secret: token.slice(separatorIndex + 1),
    };
  }

  async verifyDeviceToken(token: string) {
    const decoded = this.decodeDeviceToken(token);
    if (!decoded) return null;
    const log = this._log.child({ deviceId: decoded.deviceId });

    const device = await this._authRepository.findDeviceHash(decoded.deviceId);
    if (!device) {
      log.info('Device matching device id not found');
      return null;
    }
    if (!device.secret_hash) {
      log.warn('Device secret hash not found');
      return null;
    }

    const isValid = await this._hashService.verify(
      decoded.secret,
      device.secret_hash,
    );
    if (!isValid) {
      log.info('Device secret did not match saved hash');
      return null;
    }

    return { deviceId: device.id };
  }
}
