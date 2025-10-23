import { beforeEach, describe, expect } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type { BaseLogger } from '@scribear/base-fastify-server';

import CalculatorService from '../../../../../src/server/features/calculator/calculator.service.js';

describe('CalculatorService', () => {
  let calculatorService: CalculatorService;
  let mockLogger: MockProxy<BaseLogger>;

  beforeEach(() => {
    mockLogger = mock<BaseLogger>();
    calculatorService = new CalculatorService(mockLogger);
  });

  describe('binomial', (it) => {
    /**
     * Test that calculator adds two numbers correctly
     */
    it('correctly adds two numbers', () => {
      // Arrange
      const a = 10;
      const b = 5;
      const op = '+';

      // Act
      const result = calculatorService.binomial(a, b, op);

      // Assert
      expect(result).toBe(15);
    });

    /**
     * Test that calculator subtracts two numbers correctly
     */
    it('correctly subtracts two numbers', () => {
      // Arrange
      const a = 10;
      const b = 5;
      const op = '-';

      // Act
      const result = calculatorService.binomial(a, b, op);

      // Assert
      expect(result).toBe(5);
    });
  });

  describe('monomial', (it) => {
    /**
     * Test that calculator squares a number correctly
     */
    it('correctly squares a number', () => {
      // Arrange
      const a = 5;
      const op = 'square';

      // Act
      const result = calculatorService.monomial(a, op);

      // Assert
      expect(result).toBe(25);
    });

    /**
     * Test that calculator cubes a number correctly
     */
    it('correctly cubes a number', () => {
      // Arrange
      const a = 3;
      const op = 'cube';

      // Act
      const result = calculatorService.monomial(a, op);

      // Assert
      expect(result).toBe(27);
    });
  });
});
