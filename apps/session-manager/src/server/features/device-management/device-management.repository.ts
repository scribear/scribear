import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class DeviceManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async findDeviceByActivationCode(activationCode: string) {
    return await this._dbClient.db
      .selectFrom('devices')
      .select(['id', 'name', 'is_active', 'activation_expiry'])
      .where('activation_code', '=', activationCode)
      .executeTakeFirst();
  }

  async activateDevice(activationCode: string, secretHash: string) {
    return await this._dbClient.db
      .updateTable('devices')
      .where((eb) =>
        eb('activation_code', '=', activationCode).and('is_active', '=', false),
      )
      .set({
        secret_hash: secretHash,
        is_active: true,
        activation_code: null,
        activation_expiry: null,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
  }

  async createInactiveDevice(
    name: string,
    activationCode: string,
    activationExpiry: Date,
  ) {
    return await this._dbClient.db
      .insertInto('devices')
      .values({
        activation_code: activationCode,
        name: name,
        activation_expiry: activationExpiry,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }
}
