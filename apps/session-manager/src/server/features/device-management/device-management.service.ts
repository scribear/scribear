import crypto from 'node:crypto';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { generateRandomCode } from '#src/server/utils/generate-random-code.js';

const ACTIVATION_CODE_LENGTH = 8;
const ACTIVATION_CODE_VALID_MINUTES = 5;
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

  /**
   * Lists devices with optional filtering and cursor-based pagination.
   * @param params.search Case-insensitive name filter.
   * @param params.active Filter by activation state.
   * @param params.roomUid Filter by room membership; pass `''` to return only devices not in any room.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field.
   * @param params.limit Maximum number of items to return.
   */
  async listDevices(params: {
    search?: string;
    active?: boolean;
    roomUid?: string;
    cursor?: string;
    limit: number;
  }) {
    return this._deviceManagementRepository.list(params);
  }

  /**
   * Fetches a single device by UID.
   * @param deviceUid The device's unique identifier.
   * @returns The device, or `'DEVICE_NOT_FOUND'` if no matching device exists.
   */
  async getDevice(deviceUid: string) {
    const device = await this._deviceManagementRepository.findById(deviceUid);
    return device ?? 'DEVICE_NOT_FOUND';
  }

  /**
   * Creates a new device record in pending state with a one-time activation code.
   * @param name The human-readable name for the device.
   * @returns The device UID, plaintext activation code, and code expiry timestamp.
   */
  async registerDevice(name: string) {
    const activationCode = generateRandomCode(ACTIVATION_CODE_LENGTH);
    const expiry = new Date(
      Date.now() + ACTIVATION_CODE_VALID_MINUTES * 60 * 1000,
    );

    const result = await this._deviceManagementRepository.create({
      name,
      activationCode,
      expiry,
    });

    this._log.info({ deviceUid: result.uid }, 'Device registered');
    return { deviceUid: result.uid, activationCode, expiry };
  }

  /**
   * Resets a device to unactivated state (clears hash and active flag) and issues a new activation code.
   * @param deviceUid The device to reregister.
   */
  async reregisterDevice(deviceUid: string) {
    const existing = await this._deviceManagementRepository.findById(deviceUid);
    if (!existing) return 'DEVICE_NOT_FOUND';

    const activationCode = generateRandomCode(ACTIVATION_CODE_LENGTH);
    const expiry = new Date(
      Date.now() + ACTIVATION_CODE_VALID_MINUTES * 60 * 1000,
    );

    const result = await this._deviceManagementRepository.reregister(
      deviceUid,
      activationCode,
      expiry,
    );
    if (!result) return 'DEVICE_NOT_FOUND';

    if (!result.activation_code || !result.expiry) {
      throw new Error('Reregistration failed unexpectedly.');
    }

    this._log.info({ deviceUid }, 'Device reregistered');
    return {
      activationCode: result.activation_code,
      expiry: result.expiry.toISOString(),
    };
  }

  /**
   * Exchanges an activation code for permanent device credentials. Clears the code and expiry on success.
   * @param activationCode The one-time code issued during registration.
   * @returns The device UID and a plaintext secret (store its hash, not the secret itself), or an error code.
   */
  async activateDevice(activationCode: string) {
    const device =
      await this._deviceManagementRepository.findByActivationCode(
        activationCode,
      );
    if (!device) return 'ACTIVATION_CODE_NOT_FOUND';

    const expiry = device.expiry;
    if (!expiry || expiry < new Date()) return 'ACTIVATION_CODE_EXPIRED';

    const secret = crypto
      .randomBytes(DEVICE_SECRET_BYTES)
      .toString('base64url');
    const hash = await this._hashService.hash(secret);

    const activated = await this._deviceManagementRepository.activate(
      activationCode,
      hash,
    );
    if (!activated) return 'ACTIVATION_CODE_NOT_FOUND';

    this._log.info({ deviceUid: activated.uid }, 'Device activated');
    return { deviceUid: activated.uid, secret };
  }

  /**
   * Updates mutable fields on a device.
   * @param deviceUid The device to update.
   * @param data Fields to update; omit any field to leave it unchanged.
   * @returns The updated device, or `'DEVICE_NOT_FOUND'` if no matching device exists.
   */
  async updateDevice(deviceUid: string, data: { name?: string }) {
    const device = await this._deviceManagementRepository.update(
      deviceUid,
      data,
    );
    return device ?? 'DEVICE_NOT_FOUND';
  }

  /**
   * Deletes a device. Blocked if the device is the current source of a room.
   * @param deviceUid The device to delete.
   * @returns `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` if the device is a room's source device.
   */
  async deleteDevice(deviceUid: string) {
    const device = await this._deviceManagementRepository.findById(deviceUid);
    if (!device) return 'DEVICE_NOT_FOUND';
    if (device.isSource) return 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE';

    const deleted = await this._deviceManagementRepository.delete(deviceUid);
    if (!deleted) return 'DEVICE_NOT_FOUND';
    return;
  }

  /**
   * Returns public-facing fields for a device, suitable for returning to the device itself.
   * @param deviceUid The device's unique identifier.
   * @returns A subset of device fields, or `'DEVICE_NOT_FOUND'` if no matching device exists.
   */
  async getMyDevice(deviceUid: string) {
    const device = await this._deviceManagementRepository.findById(deviceUid);
    if (!device) return 'DEVICE_NOT_FOUND';
    return {
      uid: device.uid,
      name: device.name,
      roomUid: device.roomUid,
      isSource: device.isSource,
    };
  }
}
