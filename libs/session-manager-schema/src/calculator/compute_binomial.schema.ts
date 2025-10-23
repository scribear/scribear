import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

const COMPUTE_BINOMIAL_SCHEMA = {
  description: 'Computes a binomial',
  tags: ['Calculator'],
  body: Type.Object(
    {
      a: Type.Integer({ description: 'First operand' }),
      b: Type.Integer({ description: 'Second operand' }),
      op: Type.Union([Type.Literal('+'), Type.Literal('-')], {
        description: 'Operator',
      }),
    },
    {
      description: 'Represents a single binomial expression',
    },
  ),
  response: {
    200: Type.Object(
      {
        result: Type.Integer({ description: 'Result value of computation' }),
        reqId: Type.String(),
      },
      { description: 'Successful computation response' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const COMPUTE_BINOMIAL_ROUTE: BaseRouteSchema = {
  method: 'POST',
  url: '/calculator/binomial',
};

export { COMPUTE_BINOMIAL_SCHEMA, COMPUTE_BINOMIAL_ROUTE };
