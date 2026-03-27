import type { AppDependencies } from '../dependency-injection/register-dependencies.js';

export class AuthRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async findDeviceHash(deviceId: string) {
    return await this._dbClient.db
      .selectFrom('devices')
      .select(['id', 'secret_hash'])
      .where('id', '=', deviceId)
      .executeTakeFirst();
  }
}
