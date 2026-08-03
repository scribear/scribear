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

    // `authorization` is Type.Optional in the schema, so adminApiKeyHook - not
    // schema validation - answers this. It used to be a 400 VALIDATION_ERROR,
    // which gave "no credential" and "wrong credential" different status codes
    // for the same class of problem.
    it('returns 401 for a caller with no authorization header at all', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ADMIN_KEY');
    });

    // A key shaped like `openssl rand -base64 32` output. The old
    // `^Bearer [A-Za-z0-9_-]+$` header pattern rejected `+`, `/` and `=` during
    // validation, so such a key answered 400 even when it was correct.
    it('returns 401, not 400, for a base64-shaped key', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { authorization: 'Bearer abc+def/ghi=' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ADMIN_KEY');
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
