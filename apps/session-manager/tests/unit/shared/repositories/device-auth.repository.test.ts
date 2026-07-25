import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceAuthRepository } from '#src/server/shared/repositories/device-auth.repository.js';

describe('DeviceAuthRepository', () => {
  let chain: { select: Mock; where: Mock; executeTakeFirst: Mock };
  let mockDb: { selectFrom: Mock };
  let mockDbClient: { db: object };
  let repo: DeviceAuthRepository;

  beforeEach(() => {
    chain = {
      select: vi.fn(),
      where: vi.fn(),
      executeTakeFirst: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    mockDb = { selectFrom: vi.fn() };
    mockDb.selectFrom.mockReturnValue(chain);
    mockDbClient = { db: mockDb };
    repo = new DeviceAuthRepository(mockDbClient as never);
  });

  describe('findDeviceHash', (it) => {
    it('returns the uid and hash for an activated device', async () => {
      chain.executeTakeFirst.mockResolvedValue({
        uid: 'device-1',
        hash: 'hashed-secret',
      });

      const result = await repo.findDeviceHash('device-1');

      expect(result).toStrictEqual({ uid: 'device-1', hash: 'hashed-secret' });
    });

    it('returns a null hash for an unactivated device', async () => {
      chain.executeTakeFirst.mockResolvedValue({ uid: 'device-1', hash: null });

      const result = await repo.findDeviceHash('device-1');

      expect(result).toStrictEqual({ uid: 'device-1', hash: null });
    });

    it('returns undefined when the device is not found', async () => {
      chain.executeTakeFirst.mockResolvedValue(undefined);

      const result = await repo.findDeviceHash('unknown');

      expect(result).toBeUndefined();
    });

    it('builds the query against the devices table scoped to the device uid', async () => {
      chain.executeTakeFirst.mockResolvedValue(undefined);

      await repo.findDeviceHash('device-1');

      expect(mockDb.selectFrom).toHaveBeenCalledWith('devices');
      expect(chain.select).toHaveBeenCalledWith(['uid', 'hash']);
      expect(chain.where).toHaveBeenCalledWith('uid', '=', 'device-1');
    });
  });
});
