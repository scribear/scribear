import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { DATABASE_TAG } from '#src/tags.js';

/**
 * Which database migrations this Session Manager build ships, and which of them
 * the database it is pointed at has applied.
 *
 * This exists so the admin console's Config Check can *ask a container* what
 * schema it expects, rather than infer it. Every service in a deployment is
 * pinned to one `IMAGE_TAG`, so comparing the answer against what admin-server
 * itself was built with is what turns a half-finished upgrade — one service
 * pulled, another not — from a mystery into a named finding.
 *
 * Admin-key protected, not folded into the public readiness body: nginx proxies
 * `/api/session-manager/` to the internet, and the exact schema version of a
 * deployment is a detail for its operators.
 */
export const SCHEMA_STATUS_RESPONSE_SCHEMA = Type.Object(
  {
    initialized: Type.Boolean({
      description:
        'Whether the migration bookkeeping table exists at all. False means ' +
        'migrations have never been run against this database.',
    }),
    applied: Type.Array(Type.String(), {
      description: 'Migration names recorded in the database, ascending.',
    }),
    expected: Type.Array(Type.String(), {
      description: 'Migration names this Session Manager build ships.',
    }),
    pending: Type.Array(Type.String(), {
      description:
        'Shipped but not applied. Non-empty means the database is behind this ' +
        'build, and this service is failing its readiness probe.',
    }),
    unknown: Type.Array(Type.String(), {
      description:
        'Applied but not shipped — the database is ahead of this build, which ' +
        'is what a rollback looks like. Not an error.',
    }),
    upToDate: Type.Boolean({
      description: 'True when nothing is pending. May still have `unknown`.',
    }),
    latestApplied: Type.String({
      description: 'Newest migration recorded in the database; empty if none.',
    }),
    latestExpected: Type.String({
      description: 'Newest migration this build ships; the schema version.',
    }),
  },
  { $id: 'DatabaseSchemaStatus' },
);

export const SCHEMA_STATUS_SCHEMA = {
  description:
    'Report which database migrations this build expects and which the ' +
    'database has applied.',
  tags: [DATABASE_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  response: {
    200: SCHEMA_STATUS_RESPONSE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

export const SCHEMA_STATUS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/database/schema`,
};
