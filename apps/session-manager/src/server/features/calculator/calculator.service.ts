import type { BaseLogger } from '@scribear/base-fastify-server';

import type { AppDependencies } from '../../dependency_injection/register_dependencies.js';

class CalculatorService {
  private _log: BaseLogger;

  constructor(logger: AppDependencies['logger']) {
    this._log = logger;
  }

  binomial(a: number, b: number, op: '+' | '-') {
    this._log.info(
      `Performing bionomial operation: ${a.toString()} ${op} ${b.toString()}`,
    );

    if (op === '+') {
      return a + b;
    } else {
      return a - b;
    }
  }

  monomial(a: number, op: 'square' | 'cube') {
    this._log.info(`Performing monomial operation: ${op} ${a.toString()}`);

    if (op === 'square') {
      return a * a;
    } else {
      return a * a * a;
    }
  }
}

export default CalculatorService;
