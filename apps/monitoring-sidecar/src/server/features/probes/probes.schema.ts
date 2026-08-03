import { Type } from 'typebox';

import { MONITORING_BASE_PATH } from '#src/server/base-path.js';

export const LIVENESS_SCHEMA = {
  response: {
    200: Type.Object({ status: Type.Literal('ok') }),
  },
};

export const LIVENESS_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/probes/liveness`,
};

export const READINESS_SCHEMA = {
  response: {
    200: Type.Object({ status: Type.Literal('ok') }),
    503: Type.Object({
      status: Type.Literal('fail'),
      checks: Type.Object({ collectors: Type.String() }),
    }),
  },
};

export const READINESS_ROUTE = {
  method: 'GET' as const,
  url: `${MONITORING_BASE_PATH}/probes/readiness`,
};
