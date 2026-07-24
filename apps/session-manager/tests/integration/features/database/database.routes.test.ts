import { describe, expect } from 'vitest';

import { LATEST_MIGRATION, MIGRATION_NAMES } from '@scribear/scribear-db';

import { ADMIN_HEADER, useServer } from '#tests/utils/use-server.js';

const URL = '/api/session-manager/v1/database/schema';

interface SchemaStatus {
  initialized: boolean;
  applied: string[];
  expected: string[];
  pending: string[];
  unknown: string[];
  upToDate: boolean;
  latestApplied: string;
  latestExpected: string;
}

/**
 * Runs against the real migrated container from `global-setup.ts`, which is the
 * point: this is the only test that checks `readSchemaState` against an actual
 * `kysely_migration` table rather than a fixture, so it is what would catch the
 * static migration registry drifting from what the migrator applies.
 */
describe('Database schema route', () => {
  const server = useServer();

  describe('admin key auth', (it) => {
    it('returns 401 when the API key is invalid', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { authorization: 'Bearer wrongkey' },
      });

      expect(res.statusCode).toBe(401);
    });

    // The route declares `authorization` as a required header, so an omitted one
    // is rejected by schema validation before the hook ever runs.
    it('rejects a caller with no authorization header at all', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('a fully migrated database', (it) => {
    it('reports every shipped migration as applied', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { authorization: ADMIN_HEADER },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<SchemaStatus>();
      expect(body.initialized).toBe(true);
      expect(body.applied).toEqual([...MIGRATION_NAMES]);
      expect(body.pending).toEqual([]);
      expect(body.unknown).toEqual([]);
      expect(body.upToDate).toBe(true);
    });

    // The field the admin console compares between containers to detect a
    // half-finished upgrade, so it must be the real migration name and not, say,
    // a count or a package version.
    it('reports the newest migration as the schema version', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { authorization: ADMIN_HEADER },
      });

      const body = res.json<SchemaStatus>();
      expect(body.latestExpected).toBe(LATEST_MIGRATION);
      expect(body.latestApplied).toBe(LATEST_MIGRATION);
    });
  });
});
