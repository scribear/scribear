import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const DEPLOYMENT_VERSIONS_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/deployment-versions`,
};
