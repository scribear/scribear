import crypto from 'node:crypto';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

export class KioskManagementService {
  private _log: AppDependencies['logger'];
  private _hashService: AppDependencies['hashService'];
  private _kioskManagementRepository: AppDependencies['kioskManagementRepository'];

  constructor(
    logger: AppDependencies['logger'],
    hashService: AppDependencies['hashService'],
    kioskManagementRepository: AppDependencies['kioskManagementRepository'],
  ) {
    this._log = logger;
    this._hashService = hashService;
    this._kioskManagementRepository = kioskManagementRepository;
  }

  async createKiosk() {
    const secret = crypto.randomBytes(64).toString('hex');

    const secretHash = await this._hashService.hashValue(secret);

    const result =
      await this._kioskManagementRepository.createNewKioskEntry(secretHash);

    if (!result) {
      this._log.error('Failed to create new kiosk entry');
      return null;
    }

    const token = Buffer.from(`${result.id}:${secret}`).toString('base64');

    return { id: result.id, token };
  }
}
