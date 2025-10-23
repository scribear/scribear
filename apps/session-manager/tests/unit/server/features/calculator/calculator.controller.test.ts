import { type Mock, beforeEach, describe, expect, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import type {
  COMPUTE_BINOMIAL_SCHEMA,
  COMPUTE_MONOMIAL_SCHEMA,
} from '@scribear/session-manager-schema';

import CalculatorController from '../../../../../src/server/features/calculator/calculator.controller.js';
import type CalculatorService from '../../../../../src/server/features/calculator/calculator.service.js';

describe('Calculator controller', () => {
  const testRequestId = 'TEST_REQUEST_ID';
  let mockReply: {
    code: Mock;
    send: Mock;
  };
  let mockCalculatorService: MockProxy<CalculatorService>;
  let calculatorController: CalculatorController;

  beforeEach(() => {
    mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    mockCalculatorService = mock<CalculatorService>();
    calculatorController = new CalculatorController(mockCalculatorService);
  });

  describe('binomial handler', (it) => {
    /**
     * Test that binomial handler correctly calls calculatorService and replies with result
     */
    it('calls calculator service correctly and replies with result', () => {
      // Arrange
      const result = 46;
      mockCalculatorService.binomial.mockReturnValue(result);
      const mockReq = {
        id: testRequestId,
        body: {
          a: 12,
          b: 34,
          op: '+',
        },
      };

      // Act
      calculatorController.binomial(
        mockReq as unknown as BaseFastifyRequest<
          typeof COMPUTE_BINOMIAL_SCHEMA
        >,
        mockReply as unknown as BaseFastifyReply<
          typeof COMPUTE_BINOMIAL_SCHEMA
        >,
      );

      // Assert
      // ignore linter error caused by vitest-mock-extended
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockCalculatorService.binomial).toHaveBeenCalledExactlyOnceWith(
        mockReq.body.a,
        mockReq.body.b,
        mockReq.body.op,
      );
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        result,
      });
    });
  });

  describe('monomial handler', (it) => {
    /**
     * Test that monomial handler correctly calls calculatorService and replies with result
     */
    it('calls calculator service corrently and replies with result', () => {
      // Arrange
      const result = 144;
      mockCalculatorService.monomial.mockReturnValue(result);
      const mockReq = {
        id: testRequestId,
        body: {
          a: 12,
          op: 'square',
        },
      };

      // Act
      calculatorController.monomial(
        mockReq as unknown as BaseFastifyRequest<
          typeof COMPUTE_MONOMIAL_SCHEMA
        >,
        mockReply as unknown as BaseFastifyReply<
          typeof COMPUTE_MONOMIAL_SCHEMA
        >,
      );

      // Assert
      // ignore linter error caused by vitest-mock-extended
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockCalculatorService.monomial).toHaveBeenCalledExactlyOnceWith(
        mockReq.body.a,
        mockReq.body.op,
      );
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        result,
      });
    });
  });
});
