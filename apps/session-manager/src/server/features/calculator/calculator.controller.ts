import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import {
  COMPUTE_BINOMIAL_SCHEMA,
  type COMPUTE_MONOMIAL_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '../../dependency_injection/register_dependencies.js';
import type CalculatorService from './calculator.service.js';

class CalculatorController {
  private _calculatorService: CalculatorService;

  constructor(calculatorService: AppDependencies['calculatorService']) {
    this._calculatorService = calculatorService;
  }

  binomial(
    req: BaseFastifyRequest<typeof COMPUTE_BINOMIAL_SCHEMA>,
    res: BaseFastifyReply<typeof COMPUTE_BINOMIAL_SCHEMA>,
  ) {
    const { a, b, op } = req.body;

    const result = this._calculatorService.binomial(a, b, op);

    res.code(200).send({ result });
  }

  monomial(
    req: BaseFastifyRequest<typeof COMPUTE_MONOMIAL_SCHEMA>,
    res: BaseFastifyReply<typeof COMPUTE_MONOMIAL_SCHEMA>,
  ) {
    const { a, op } = req.body;

    const result = this._calculatorService.monomial(a, op);

    res.code(200).send({ result });
  }
}

export default CalculatorController;
