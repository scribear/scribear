import { describe, expect, vi } from 'vitest';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

type LooseHandler = (req: unknown, res: unknown) => Promise<unknown>;

describe('resolveHandler', () => {
  describe('happy path', (it) => {
    it('resolves the controller from the request DI scope and delegates to the bound method', async () => {
      const mockController = {
        readiness: vi.fn().mockResolvedValue({ status: 'ok' }),
      };
      const mockReq = {
        diScope: { resolve: vi.fn().mockReturnValue(mockController) },
      };
      const mockRes = {};

      const handler = resolveHandler(
        'readinessController',
        'readiness',
      ) as LooseHandler;
      const result = await handler(mockReq, mockRes);

      expect(mockReq.diScope.resolve).toHaveBeenCalledWith(
        'readinessController',
      );
      expect(mockController.readiness).toHaveBeenCalledWith(mockReq, mockRes);
      expect(mockController.readiness.mock.instances[0]).toBe(mockController);
      expect(result).toStrictEqual({ status: 'ok' });
    });
  });

  describe('missing-method guard', (it) => {
    it('throws when the method does not exist on the controller', async () => {
      const mockReq = {
        diScope: { resolve: vi.fn().mockReturnValue({}) },
      };

      const handler = resolveHandler(
        'readinessController',
        'missing' as never,
      ) as LooseHandler;

      await expect(handler(mockReq, {})).rejects.toThrow(
        /is not a function/,
      );
    });

    it('throws when the method exists but is not a function', async () => {
      const mockReq = {
        diScope: {
          resolve: vi.fn().mockReturnValue({ readiness: 'not-a-function' }),
        },
      };

      const handler = resolveHandler(
        'readinessController',
        'readiness' as never,
      ) as LooseHandler;

      await expect(handler(mockReq, {})).rejects.toThrow(
        /is not a function/,
      );
    });
  });
});
