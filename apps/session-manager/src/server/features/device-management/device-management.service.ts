import crypto from 'node:crypto';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

const ACTIVATION_CODE_LENGTH = 8;
const ACTIVATION_CODE_VALID_MIN = 5;

const DEVICE_SECRET_BYTES = 64;

export class DeviceManagementService {
  private _log: AppDependencies['logger'];
  private _deviceManagementRepository: AppDependencies['deviceManagementRepository'];
  private _hashService: AppDependencies['hashService'];

  constructor(
    logger: AppDependencies['logger'],
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
    hashService: AppDependencies['hashService'],
  ) {
    this._log = logger;
    this._deviceManagementRepository = deviceManagementRepository;
    this._hashService = hashService;
  }

  async registerDevice(deviceName: string) {
    const timeNowMs = Date.now();
    const expiryMs = timeNowMs + ACTIVATION_CODE_VALID_MIN * 60 * 1000;
    const activationExpiry = new Date(expiryMs);

    const activationCode = generateRandomCode(ACTIVATION_CODE_LENGTH);
    const result = await this._deviceManagementRepository.createInactiveDevice(
      deviceName,
      activationCode,
      activationExpiry,
    );

    return { deviceId: result.id, activationCode };
  }

  async activateDevice(activationCode: string) {
    const inactiveDevice =
      await this._deviceManagementRepository.findDeviceByActivationCode(
        activationCode,
      );
    if (!inactiveDevice) {
      this._log.warn('Activation code not found');
      return null;
    }

    // Check that device activation code is valid
    const log = this._log.child({ deviceId: inactiveDevice.id });
    if (inactiveDevice.is_active) {
      log.warn('Device is already active');
      return null;
    }
    if (!inactiveDevice.activation_expiry) {
      log.warn('Device activation expiry not found');
      return null;
    }
    if (inactiveDevice.activation_expiry < new Date()) {
      log.info('Device activation expired');
      return null;
    }

    const deviceSecret = crypto
      .randomBytes(DEVICE_SECRET_BYTES)
      .toString('base64url');
    const secretHash = await this._hashService.hash(deviceSecret);

    const result = await this._deviceManagementRepository.activateDevice(
      activationCode,
      secretHash,
    );

    return {
      deviceId: result.id,
      deviceName: result.name,
      deviceSecret,
    };
  }
}
