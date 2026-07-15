import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class DeviceAuthRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /**
   * Fetches the stored bcrypt hash for a device, used to verify a presented token.
   * @param deviceUid The device's unique identifier.
   * @returns `{ uid, hash }` if the device exists, `undefined` if not found. `hash` is `null` for unactivated devices.
   */
  async findDeviceHash(
    deviceUid: string,
  ): Promise<{ uid: string; hash: string | null } | undefined> {
    return await this._dbClient.db
      .selectFrom('devices')
      .select(['uid', 'hash'])
      .where('uid', '=', deviceUid)
      .executeTakeFirst();
  }
}
