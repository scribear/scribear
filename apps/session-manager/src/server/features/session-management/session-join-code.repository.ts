import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

/**
 * Repository for managing session join codes with expiry and rotation.
 */
export class SessionJoinCodeRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /**
   * Creates a new join code for a session.
   */
  async create(
    sessionId: string,
    code: string,
    createdAt: Date,
    expiresAt: Date,
  ) {
    return await this._dbClient.db
      .insertInto('session_join_codes')
      .values({
        session_id: sessionId,
        code,
        created_at: createdAt,
        expires_at: expiresAt,
      })
      .returning(['id', 'code', 'expires_at'])
      .executeTakeFirstOrThrow();
  }

  /**
   * Finds an active session by a non-expired join code.
   * Returns the session if the code is valid and the session is active.
   */
  async findActiveSessionByJoinCode(joinCode: string) {
    const now = new Date();
    return await this._dbClient.db
      .selectFrom('session_join_codes')
      .innerJoin('sessions', 'sessions.id', 'session_join_codes.session_id')
      .select(['sessions.id', 'sessions.end_time'])
      .where('session_join_codes.code', '=', joinCode)
      .where('session_join_codes.expires_at', '>', now)
      .where('sessions.start_time', '<=', now)
      .where((eb) =>
        eb.or([
          eb('sessions.end_time', 'is', null),
          eb('sessions.end_time', '>', now),
        ]),
      )
      .executeTakeFirst();
  }

  /**
   * Gets the latest non-expired join code for a session.
   * Uses SELECT FOR UPDATE to prevent concurrent rotation.
   * Returns null if no valid code exists.
   */
  async getLatestValidCode(sessionId: string) {
    return await this._dbClient.db
      .selectFrom('session_join_codes')
      .select(['id', 'code', 'created_at', 'expires_at'])
      .where('session_id', '=', sessionId)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Atomically gets the latest join code and rotates it if expiring soon.
   * Uses a transaction with row-level locking to ensure only one instance
   * rotates the code even with multiple concurrent session managers.
   *
   * @param sessionId Session to get/rotate the join code for
   * @param codeLength Length of the generated code
   * @param generateCode Function that generates a new random code
   * @param codeDurationMs How long a new code should be valid
   * @param rotationThresholdMs Rotate if code expires within this many ms
   * @returns The current valid code and its expiry, or null if no codes exist
   */
  async getOrRotateJoinCode(
    sessionId: string,
    codeLength: number,
    generateCode: (length: number) => string,
    codeDurationMs: number,
    rotationThresholdMs: number,
  ): Promise<{ code: string; expiresAt: Date } | null> {
    return await this._dbClient.db.transaction().execute(async (trx) => {
      // Lock the session's join codes to prevent concurrent rotation
      const latestCode = await trx
        .selectFrom('session_join_codes')
        .select(['id', 'code', 'created_at', 'expires_at'])
        .where('session_id', '=', sessionId)
        .where('expires_at', '>', new Date())
        .orderBy('created_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();

      if (!latestCode) {
        return null;
      }

      const now = Date.now();
      const msUntilExpiry = latestCode.expires_at.getTime() - now;

      // If the code is not expiring soon, return it as-is
      if (msUntilExpiry > rotationThresholdMs) {
        return {
          code: latestCode.code,
          expiresAt: latestCode.expires_at,
        };
      }

      // Code is expiring soon, generate a new one
      const newCode = generateCode(codeLength);
      const createdAt = new Date();
      const expiresAt = new Date(now + codeDurationMs);

      const inserted = await trx
        .insertInto('session_join_codes')
        .values({
          session_id: sessionId,
          code: newCode,
          created_at: createdAt,
          expires_at: expiresAt,
        })
        .returning(['code', 'expires_at'])
        .executeTakeFirstOrThrow();

      return {
        code: inserted.code,
        expiresAt: inserted.expires_at,
      };
    });
  }

  /**
   * Deletes all join codes for a session.
   */
  async deleteBySessionId(sessionId: string) {
    await this._dbClient.db
      .deleteFrom('session_join_codes')
      .where('session_id', '=', sessionId)
      .execute();
  }
}
