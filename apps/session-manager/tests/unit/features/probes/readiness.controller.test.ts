import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';

/**
 * The readiness probe answers two questions — is the database reachable, and is
 * its schema new enough for this build — and the value of separating them is that
 * an operator reading a red dot can tell "Postgres is down" from "nobody ran the
 * migrations". These tests pin that separation, since collapsing the two is the
 * easy mistake and it silently costs the diagnosis.
 */
describe('ReadinessController', (it) => {
  let mockDbClient: { db: object; pendingMigrations: Mock };
  let mockSend: Mock;
  let mockCode: Mock;
  let mockRes: { code: Mock };
  let mockLogger: { error: Mock };

  /** A `db` whose one query either resolves or rejects. */
  function db(reachable: boolean) {
    const execute = reachable
      ? () => Promise.resolve([])
      : () => Promise.reject(new Error('ECONNREFUSED'));
    const chain = {
      select: () => chain,
      limit: () => chain,
      execute,
    };
    return { selectFrom: () => chain };
  }

  function build(reachable: boolean, pending: string[]) {
    mockDbClient = {
      db: db(reachable),
      pendingMigrations: vi.fn().mockResolvedValue(pending),
    };
    return new ReadinessController(
      mockDbClient as never,
      mockLogger as never,
    );
  }

  beforeEach(() => {
    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockRes = { code: mockCode };
    mockLogger = { error: vi.fn() };
  });

  it('is ready when the database answers and the schema is current', async () => {
    await build(true, []).readiness({} as never, mockRes as never);

    expect(mockCode).toHaveBeenCalledWith(200);
    expect(mockSend).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('fails both checks when the database cannot be reached', async () => {
    const controller = build(false, []);

    await controller.readiness({} as never, mockRes as never);

    expect(mockCode).toHaveBeenCalledWith(503);
    expect(mockSend).toHaveBeenCalledWith({
      status: 'fail',
      checks: { database: 'fail', schema: 'fail' },
    });
    // Asking a database that will not answer about its schema would only produce
    // a second, worse explanation of the first failure.
    expect(mockDbClient.pendingMigrations).not.toHaveBeenCalled();
  });

  // The case this whole check exists for: Postgres is fine, the migrations were
  // never applied, and before this the probe was green while routes 500'd on
  // missing columns.
  it('fails the schema check alone when migrations are pending', async () => {
    await build(true, ['00000011-device-last-seen']).readiness(
      {} as never,
      mockRes as never,
    );

    expect(mockCode).toHaveBeenCalledWith(503);
    expect(mockSend).toHaveBeenCalledWith({
      status: 'fail',
      checks: { database: 'ok', schema: 'fail' },
    });
  });

  it('names the pending migrations in the log, for the container logs', async () => {
    await build(true, ['00000011-device-last-seen']).readiness(
      {} as never,
      mockRes as never,
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      { pending: ['00000011-device-last-seen'] },
      expect.stringContaining('behind this build'),
    );
  });
});
