import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

export class AuthRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async findKioskSecretHash(kioskId: string) {
    return await this._dbClient.db
      .selectFrom('kiosks')
      .select('secret_hash')
      .where('id', '=', kioskId)
      .executeTakeFirst();
  }
}
