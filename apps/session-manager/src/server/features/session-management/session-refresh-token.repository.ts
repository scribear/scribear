import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class SessionRefreshTokenRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /**
   * Creates a refresh token record.
   * @returns The generated token ID.
   */
  async create(
    sessionId: string,
    scope: string[],
    authMethod: string,
    expiry: Date | null,
    secretHash: string,
  ) {
    return await this._dbClient.db
      .insertInto('session_refresh_tokens')
      .values({
        session_id: sessionId,
        scope,
        auth_method: authMethod,
        expiry,
        secret_hash: secretHash,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async findById(id: string) {
    return await this._dbClient.db
      .selectFrom('session_refresh_tokens')
      .select([
        'id',
        'session_id',
        'scope',
        'auth_method',
        'expiry',
        'secret_hash',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async deleteBySessionId(sessionId: string) {
    await this._dbClient.db
      .deleteFrom('session_refresh_tokens')
      .where('session_id', '=', sessionId)
      .execute();
  }
}
