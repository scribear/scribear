import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';

import type { AuthMethod, DB, SessionScope } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export type DBOrTrx = Kysely<DB> | Transaction<DB>;

/** A persisted `session_join_codes` row mapped to camelCase. */
export interface JoinCode {
  joinCode: string;
  sessionUid: string;
  validStart: Date;
  validEnd: Date;
}

/**
 * Subset of `sessions` columns relevant to authentication. Effective start/end
 * are precomputed to mirror the convention used in `schedule-management`.
 */
export interface SessionAuthRow {
  uid: string;
  roomUid: string;
  joinCodeScopes: SessionScope[];
  effectiveStart: Date;
  effectiveEnd: Date | null;
}

/** A persisted `session_refresh_tokens` row mapped to camelCase. */
export interface RefreshTokenRow {
  uid: string;
  sessionUid: string;
  clientId: string;
  hash: string;
  scopes: SessionScope[];
  authMethod: AuthMethod;
}

/**
 * Parses a PostgreSQL enum-array value returned by the pg driver. Custom enum
 * arrays are not registered in the type OID table, so the driver returns them
 * as raw `{X,Y}` strings instead of JS arrays.
 */
function parsePgEnumArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string' || value === '{}') return [];
  return value.slice(1, -1).split(',');
}

/**
 * Data-access primitives for session authentication. Operations on
 * `session_join_codes` and `session_refresh_tokens`, plus the lightweight
 * session/membership lookups the auth flow needs.
 *
 * All methods accept a `Kysely<DB> | Transaction<DB>` so callers can compose
 * multi-step flows in a single transaction; this repository never opens one
 * of its own.
 */
export class SessionAuthRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /** Underlying kysely client for callers that need to run reads outside a transaction. */
  get db(): Kysely<DB> {
    return this._dbClient.db;
  }

  /**
   * Fetches the auth-relevant fields for a session. Returns the precomputed
   * `effectiveStart` / `effectiveEnd` so callers can apply the same active
   * predicate used elsewhere in the codebase.
   */
  async findSessionForAuth(
    db: DBOrTrx,
    sessionUid: string,
  ): Promise<SessionAuthRow | undefined> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    const row = await db
      .selectFrom('sessions')
      .select([
        'uid',
        'room_uid',
        'join_code_scopes',
        effectiveStart.as('effective_start'),
        effectiveEnd.as('effective_end'),
      ])
      .where('uid', '=', sessionUid)
      .executeTakeFirst();

    if (!row) return undefined;
    return {
      uid: row.uid,
      roomUid: row.room_uid,
      joinCodeScopes: parsePgEnumArray(row.join_code_scopes) as SessionScope[],
      effectiveStart: row.effective_start,
      effectiveEnd: row.effective_end,
    };
  }

  /**
   * Returns true if the device is currently a member of the given room.
   */
  async isDeviceInRoom(
    db: DBOrTrx,
    deviceUid: string,
    roomUid: string,
  ): Promise<boolean> {
    const row = await db
      .selectFrom('room_devices')
      .select('device_uid')
      .where('device_uid', '=', deviceUid)
      .where('room_uid', '=', roomUid)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Returns true if the device is the source of the given room.
   */
  async isDeviceSourceForRoom(
    db: DBOrTrx,
    deviceUid: string,
    roomUid: string,
  ): Promise<boolean> {
    const row = await db
      .selectFrom('room_devices')
      .select('is_source')
      .where('device_uid', '=', deviceUid)
      .where('room_uid', '=', roomUid)
      .executeTakeFirst();
    return row?.is_source === true;
  }

  /**
   * Lists join codes for a session whose `valid_end > now`, ordered by
   * `valid_start` ascending (chronological order). Used by `fetchJoinCodes`
   * to compute the current/next pair without issuing fresh codes when
   * existing ones are still good.
   */
  async findActiveJoinCodes(
    db: DBOrTrx,
    sessionUid: string,
    now: Date,
  ): Promise<JoinCode[]> {
    const rows = await db
      .selectFrom('session_join_codes')
      .select(['join_code', 'session_uid', 'valid_start', 'valid_end'])
      .where('session_uid', '=', sessionUid)
      .where('valid_end', '>', now)
      .orderBy('valid_start', 'asc')
      .execute();
    return rows.map((r) => ({
      joinCode: r.join_code,
      sessionUid: r.session_uid,
      validStart: r.valid_start,
      validEnd: r.valid_end,
    }));
  }

  /**
   * Inserts a new join code row.
   */
  async insertJoinCode(
    db: DBOrTrx,
    data: {
      joinCode: string;
      sessionUid: string;
      validStart: Date;
      validEnd: Date;
    },
  ): Promise<JoinCode> {
    const row = await db
      .insertInto('session_join_codes')
      .values({
        join_code: data.joinCode,
        session_uid: data.sessionUid,
        valid_start: data.validStart,
        valid_end: data.validEnd,
      })
      .returning(['join_code', 'session_uid', 'valid_start', 'valid_end'])
      .executeTakeFirstOrThrow();
    return {
      joinCode: row.join_code,
      sessionUid: row.session_uid,
      validStart: row.valid_start,
      validEnd: row.valid_end,
    };
  }

  /**
   * Returns the join code row for a given code, or `undefined` if no row
   * exists. Caller is responsible for the expiry check (we want a distinct
   * 410 response for known-but-expired codes vs 404 for unknown codes).
   */
  async findJoinCodeByCode(
    db: DBOrTrx,
    joinCode: string,
  ): Promise<JoinCode | undefined> {
    const row = await db
      .selectFrom('session_join_codes')
      .select(['join_code', 'session_uid', 'valid_start', 'valid_end'])
      .where('join_code', '=', joinCode)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      joinCode: row.join_code,
      sessionUid: row.session_uid,
      validStart: row.valid_start,
      validEnd: row.valid_end,
    };
  }

  /**
   * Inserts a session refresh token row and returns the generated UID.
   * The plaintext secret is hashed by the caller; only the hash is persisted.
   */
  async insertRefreshToken(
    db: DBOrTrx,
    data: {
      sessionUid: string;
      clientId: string;
      hash: string;
      scopes: SessionScope[];
      authMethod: AuthMethod;
    },
  ): Promise<{ uid: string }> {
    const row = await db
      .insertInto('session_refresh_tokens')
      .values({
        session_uid: data.sessionUid,
        client_id: data.clientId,
        hash: data.hash,
        scopes: data.scopes,
        auth_method: data.authMethod,
      })
      .returning('uid')
      .executeTakeFirstOrThrow();
    return { uid: row.uid };
  }

  /**
   * Fetches a refresh token row by UID. Used by the refresh flow to look up
   * the stored hash for verification.
   */
  async findRefreshTokenByUid(
    db: DBOrTrx,
    uid: string,
  ): Promise<RefreshTokenRow | undefined> {
    const row = await db
      .selectFrom('session_refresh_tokens')
      .select([
        'uid',
        'session_uid',
        'client_id',
        'hash',
        'scopes',
        'auth_method',
      ])
      .where('uid', '=', uid)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      uid: row.uid,
      sessionUid: row.session_uid,
      clientId: row.client_id,
      hash: row.hash,
      scopes: parsePgEnumArray(row.scopes) as SessionScope[],
      authMethod: row.auth_method,
    };
  }
}
