import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SharedErrorReplySchema,
} from '@scribear/base-schema';

const COMPUTE_MONOMIAL_SCHEMA = {
  description: 'Computes a monomial',
  tags: ['Calculator'],
  body: Type.Object(
    {
      a: Type.Integer({ description: 'Operand' }),
      op: Type.Union([Type.Literal('square'), Type.Literal('cube')], {
        description: 'Operator',
      }),
    },
    {
      description: 'Represents a single monomial expression',
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
    400: SharedErrorReplySchema[400],
    500: SharedErrorReplySchema[500],
  },
};

const COMPUTE_MONOMIAL_ROUTE: BaseRouteSchema = {
  method: 'POST',
  url: '/calculator/monomial',
};

export { COMPUTE_MONOMIAL_SCHEMA, COMPUTE_MONOMIAL_ROUTE };
