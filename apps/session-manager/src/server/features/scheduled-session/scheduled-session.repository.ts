import type { Insertable } from 'kysely';

import type { ScheduledSessions } from '@scribear/scribear-db';

import type { AppDependencies } from '@/server/dependency-injection/register-dependencies.js';

/**
 * Plain row type returned from SELECT queries.
 * ScheduledSessions from database.types.ts uses Generated<> wrappers
 * which don't directly cast to plain types. This interface represents
 * what Kysely actually returns after a query executes — all plain types.
 */
export interface ScheduledSessionRow {
  id: string;
  kiosk_id: string;
  title: string;
  session_length: number;
  scheduled_at: Date;
  recurrence_rule: string | null;
}

export interface ListScheduledSessionsParams {
  limit: number;
  offset: number;
  from?: string | undefined;
  to?: string | undefined;
}

export class ScheduledSessionRepository {
  private _db: AppDependencies['dbClient']['db'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._db = dbClient.db;
  }

  async create(
    data: Insertable<ScheduledSessions>,
  ): Promise<ScheduledSessionRow> {
    const result = await this._db
      .insertInto('scheduled_sessions')
      .values(data)
      .returningAll()
      .executeTakeFirstOrThrow();

    return result as ScheduledSessionRow;
  }

  async findById(id: string): Promise<ScheduledSessionRow | undefined> {
    const result = await this._db
      .selectFrom('scheduled_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return result as ScheduledSessionRow | undefined;
  }

  async list(
    params: ListScheduledSessionsParams,
  ): Promise<{ items: ScheduledSessionRow[]; total: number }> {
    let baseQuery = this._db.selectFrom('scheduled_sessions');

    if (params.from) {
      baseQuery = baseQuery.where('scheduled_at', '>=', new Date(params.from));
    }
    if (params.to) {
      baseQuery = baseQuery.where('scheduled_at', '<', new Date(params.to));
    }

    const countResult = await baseQuery
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();

    const items = await baseQuery
      .selectAll()
      .orderBy('scheduled_at', 'asc')
      .limit(params.limit)
      .offset(params.offset)
      .execute();

    return {
      items: items as ScheduledSessionRow[],
      total: Number(countResult.total),
    };
  }

  async update(
    id: string,
    data: Partial<Omit<ScheduledSessionRow, 'id'>>,
  ): Promise<ScheduledSessionRow | undefined> {
    const result = await this._db
      .updateTable('scheduled_sessions')
      .set(data)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return result as ScheduledSessionRow | undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this._db
      .deleteFrom('scheduled_sessions')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }
}