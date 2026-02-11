import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

export class KioskManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async createNewKioskEntry(secretHash: string) {
    const result = await this._dbClient.db
      .insertInto('kiosks')
      .values({
        secret_hash: secretHash,
      })
      .returning(['id'])
      .executeTakeFirst();

    return result;
  }
}
