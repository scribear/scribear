import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

const TOKEN_SEPARATOR = ':';

export class DeviceAuthService {
  private _log: AppDependencies['logger'];
  private _deviceAuthRepository: AppDependencies['deviceAuthRepository'];
  private _hashService: AppDependencies['hashService'];

  constructor(
    logger: AppDependencies['logger'],
    deviceAuthRepository: AppDependencies['deviceAuthRepository'],
    hashService: AppDependencies['hashService'],
  ) {
    this._log = logger;
    this._deviceAuthRepository = deviceAuthRepository;
    this._hashService = hashService;
  }

  /**
   * Encodes a device UID and secret into a `{uid}:{secret}` token string.
   * @param deviceUid The device's unique identifier.
   * @param secret The device's plaintext secret.
   */
  encode(deviceUid: string, secret: string): string {
    return `${deviceUid}${TOKEN_SEPARATOR}${secret}`;
  }

  /**
   * Splits on the first `:` only, so secrets containing `:` are preserved.
   * @param token A token produced by {@link encode}.
   * @returns The decoded parts, or `null` if no separator is found.
   */
  decode(token: string): { deviceUid: string; secret: string } | null {
    const idx = token.indexOf(TOKEN_SEPARATOR);
    if (idx === -1) {
      this._log.info('Device token missing separator');
      return null;
    }
    return {
      deviceUid: token.slice(0, idx),
      secret: token.slice(idx + 1),
    };
  }

  /**
   * Decodes the token, looks up the device's stored hash, and verifies via bcrypt.
   * @param token A token produced by {@link encode}.
   * @returns The device UID on success, or `null` on any failure (missing device, unset hash, wrong secret).
   */
  async verify(token: string): Promise<{ deviceUid: string } | null> {
    const decoded = this.decode(token);
    if (!decoded) return null;
    const log = this._log.child({ deviceUid: decoded.deviceUid });

    const device = await this._deviceAuthRepository.findDeviceHash(
      decoded.deviceUid,
    );
    if (!device) {
      log.info('Device not found');
      return null;
    }
    if (!device.hash) {
      log.warn('Device hash not set (device not yet activated)');
      return null;
    }

    const isValid = await this._hashService.verify(decoded.secret, device.hash);
    if (!isValid) {
      log.info('Device secret mismatch');
      return null;
    }

    return { deviceUid: device.uid };
  }
}
