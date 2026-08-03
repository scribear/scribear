import { beforeEach, describe, expect } from 'vitest';

import type { DB } from '@scribear/scribear-db';
import {
  Kysely,
  PostgresAdapter,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';

import { ScheduleManagementRepository } from '#src/server/features/schedule-management/schedule-management.repository.js';

interface FakeDb {
  db: Kysely<DB>;
  queries: CompiledQuery[];
  setNextResult: (rows: unknown[]) => void;
}

function createFakeDb(initialRows: unknown[] = []): FakeDb {
  const queries: CompiledQuery[] = [];
  let nextRows = initialRows;
  const connection = {
    executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(q);
      return Promise.resolve({ rows: nextRows } as QueryResult<R>);
    },
  } as unknown as DatabaseConnection;
  const driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    releaseConnection: () => Promise.resolve(),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  } as unknown as Driver;
  const dialect: Dialect = {
    createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (() => ({})) as never,
  };
  const db = new Kysely<DB>({ dialect });
  return {
    db,
    queries,
    setNextResult: (rows: unknown[]) => {
      nextRows = rows;
    },
  };
}

describe('ScheduleManagementRepository', () => {
  let repository: ScheduleManagementRepository;

  beforeEach(() => {
    repository = new ScheduleManagementRepository({} as never);
  });

  describe('findOneStaleRoomForMaterialization', (it) => {
    it('constructs a FOR UPDATE SKIP LOCKED query', async () => {
      const { db, queries } = createFakeDb([]);

      await repository.findOneStaleRoomForMaterialization(
        db,
        new Date('2024-06-01T00:00:00Z'),
      );

      const sqlText = queries[0]!.sql;
      expect(sqlText).toContain('for update');
      expect(sqlText).toContain('skip locked');
      expect(sqlText).toContain('last_materialized_at');
    });

    it('filters rooms where last_materialized_at IS NULL OR older than cutoff', async () => {
      const { db, queries } = createFakeDb([]);
      const cutoff = new Date('2024-06-01T00:00:00Z');

      await repository.findOneStaleRoomForMaterialization(db, cutoff);

      const sqlText = queries[0]!.sql;
      expect(sqlText).toContain('is null');
      expect(sqlText).toContain('<');
      expect(queries[0]!.parameters[0]).toBe(cutoff);
    });

    it('returns undefined when no stale rooms exist', async () => {
      const { db } = createFakeDb([]);

      const result = await repository.findOneStaleRoomForMaterialization(
        db,
        new Date('2024-06-01T00:00:00Z'),
      );

      expect(result).toBeUndefined();
    });

    it('returns the mapped room when a stale room is found', async () => {
      const { db } = createFakeDb([
        {
          uid: 'room-1',
          timezone: 'America/New_York',
          auto_session_enabled: true,
        },
      ]);

      const result = await repository.findOneStaleRoomForMaterialization(
        db,
        new Date('2024-06-01T00:00:00Z'),
      );

      expect(result).toEqual({
        uid: 'room-1',
        timezone: 'America/New_York',
        autoSessionEnabled: true,
      });
    });

    it('applies excludeUids as a NOT IN filter', async () => {
      const { db, queries } = createFakeDb([]);

      await repository.findOneStaleRoomForMaterialization(
        db,
        new Date('2024-06-01T00:00:00Z'),
        ['room-a', 'room-b'],
      );

      const sqlText = queries[0]!.sql;
      expect(sqlText).toContain('not in');
      const params = queries[0]!.parameters;
      expect(params).toContain('room-a');
      expect(params).toContain('room-b');
    });

    it('omits the NOT IN filter when excludeUids is empty', async () => {
      const { db, queries } = createFakeDb([]);

      await repository.findOneStaleRoomForMaterialization(
        db,
        new Date('2024-06-01T00:00:00Z'),
        [],
      );

      expect(queries[0]!.sql).not.toContain('not in');
    });
  });

  describe('setSessionsConstraintsDeferred', (it) => {
    it('emits SET CONSTRAINTS sessions_no_overlap DEFERRED', async () => {
      const { db, queries } = createFakeDb([]);

      await repository.setSessionsConstraintsDeferred(db);

      expect(queries[0]!.sql).toBe(
        'SET CONSTRAINTS sessions_no_overlap DEFERRED',
      );
    });
  });

  describe('lockRoom', (it) => {
    it('constructs a FOR UPDATE query without SKIP LOCKED', async () => {
      const { db, queries } = createFakeDb([]);

      await repository.lockRoom(db, 'room-1');

      const sqlText = queries[0]!.sql;
      expect(sqlText).toContain('for update');
      expect(sqlText).not.toContain('skip locked');
    });

    it('returns undefined when the room does not exist', async () => {
      const { db } = createFakeDb([]);

      const result = await repository.lockRoom(db, 'room-1');

      expect(result).toBeUndefined();
    });

    it('returns the mapped room identity when found', async () => {
      const { db } = createFakeDb([
        {
          uid: 'room-1',
          timezone: 'UTC',
          auto_session_enabled: false,
        },
      ]);

      const result = await repository.lockRoom(db, 'room-1');

      expect(result).toEqual({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
    });
  });

  describe('row mapping (parsePgEnumArray)', (it) => {
    const rawScheduleRow = {
      uid: 'sched-1',
      room_uid: 'room-1',
      name: 'Standup',
      active_start: new Date('2024-06-03T00:00:00Z'),
      active_end: null,
      anchor_start: new Date('2024-05-06T00:00:00Z'),
      local_start_time: '09:00:00',
      local_end_time: '10:00:00',
      frequency: 'WEEKLY',
      days_of_week: '{MON,TUE}',
      join_code_scopes: '{RECEIVE_TRANSCRIPTIONS}',
      transcription_provider_id: 'whisper',
      transcription_stream_config: {},
      created_at: new Date('2024-06-01T00:00:00Z'),
    };

    it('maps days_of_week from a pg enum array string to a JS array', async () => {
      const { db } = createFakeDb([rawScheduleRow]);

      const result = await repository.findScheduleByUid(db, 'sched-1');

      expect(result?.daysOfWeek).toEqual(['MON', 'TUE']);
    });

    it('maps days_of_week null to null', async () => {
      const { db } = createFakeDb([
        { ...rawScheduleRow, days_of_week: null, frequency: 'ONCE' },
      ]);

      const result = await repository.findScheduleByUid(db, 'sched-1');

      expect(result?.daysOfWeek).toBeNull();
    });

    it('maps join_code_scopes from a pg enum array string to a JS array', async () => {
      const { db } = createFakeDb([rawScheduleRow]);

      const result = await repository.findScheduleByUid(db, 'sched-1');

      expect(result?.joinCodeScopes).toEqual(['RECEIVE_TRANSCRIPTIONS']);
    });

    it('maps an empty pg enum array string {} to an empty array', async () => {
      const { db } = createFakeDb([
        { ...rawScheduleRow, join_code_scopes: '{}' },
      ]);

      const result = await repository.findScheduleByUid(db, 'sched-1');

      expect(result?.joinCodeScopes).toEqual([]);
    });
  });

  describe('bumpScheduleVersion', (it) => {
    it('emits an UPDATE that increments room_schedule_version with RETURNING', async () => {
      const { db, queries } = createFakeDb([
        { room_schedule_version: 42n },
      ]);

      const result = await repository.bumpScheduleVersion(db, 'room-1');

      const sqlText = queries[0]!.sql;
      expect(sqlText).toContain('update "rooms"');
      expect(sqlText).toContain('room_schedule_version + 1');
      expect(sqlText).toContain('returning');
      expect(result).toBe(42);
    });
  });

  describe('updateSessionScheduledEnd', (it) => {
    it('narrows the bigint session_config_version to a JS number', async () => {
      const { db } = createFakeDb([{ session_config_version: 7n }]);

      const result = await repository.updateSessionScheduledEnd(
        db,
        'sess-1',
        new Date('2024-06-03T15:00:00Z'),
      );

      expect(result).toBe(7);
      expect(typeof result).toBe('number');
    });
  });
});
