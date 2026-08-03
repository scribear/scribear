import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

vi.mock('@scribear/scribear-db', () => ({
  readSchemaState: vi.fn(),
}));

import { readSchemaState } from '@scribear/scribear-db';
import { DBClient } from '#src/db/db-client.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const mockReadSchemaState = readSchemaState as unknown as Mock;

describe('DBClient', () => {
  let dbClient: DBClient;

  beforeEach(() => {
    mockReadSchemaState.mockReset();
    dbClient = new DBClient(createMockLogger() as never, {
      dbHost: 'localhost',
      dbPort: 5432,
      dbName: 'test',
      dbUser: 'test',
      dbPassword: 'test',
    });
  });

  describe('pendingMigrations', (it) => {
    it('caches the empty result after the first up-to-date read', async () => {
      mockReadSchemaState.mockResolvedValue({ upToDate: true, pending: [] });

      const result = await dbClient.pendingMigrations();

      expect(result).toStrictEqual([]);
      expect(mockReadSchemaState).toHaveBeenCalledTimes(1);
    });

    it('returns the cached empty list without re-reading the schema on the second call', async () => {
      mockReadSchemaState.mockResolvedValue({ upToDate: true, pending: [] });

      await dbClient.pendingMigrations();
      mockReadSchemaState.mockClear();

      const result = await dbClient.pendingMigrations();

      expect(result).toStrictEqual([]);
      expect(mockReadSchemaState).not.toHaveBeenCalled();
    });

    it('does not cache when migrations are pending and returns the list', async () => {
      mockReadSchemaState.mockResolvedValue({
        upToDate: false,
        pending: ['00000011-device-last-seen'],
      });

      const result = await dbClient.pendingMigrations();

      expect(result).toStrictEqual(['00000011-device-last-seen']);
      expect(mockReadSchemaState).toHaveBeenCalledTimes(1);
    });

    it('reads the schema again on the next call after a non-empty result', async () => {
      mockReadSchemaState.mockResolvedValue({
        upToDate: false,
        pending: ['00000011-device-last-seen'],
      });

      await dbClient.pendingMigrations();
      mockReadSchemaState.mockClear();

      const result = await dbClient.pendingMigrations();

      expect(result).toStrictEqual(['00000011-device-last-seen']);
      expect(mockReadSchemaState).toHaveBeenCalledTimes(1);
    });
  });
});
