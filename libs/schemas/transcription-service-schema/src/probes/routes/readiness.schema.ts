import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

const READINESS_SCHEMA = {
  description:
    'Readiness probe. Returns 200 when the service is ready to accept transcription work. Returns 503 when not.',
  tags: [],
  response: {
    200: Type.Object(
      { status: Type.Literal('ok') },
      { description: 'Service is ready.' },
    ),
    503: Type.Object(
      { status: Type.Literal('fail') },
      { description: 'Service is not ready.' },
    ),
  },
} satisfies BaseRouteSchema;

const READINESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/probes/readiness',
};

export { READINESS_SCHEMA, READINESS_ROUTE };
