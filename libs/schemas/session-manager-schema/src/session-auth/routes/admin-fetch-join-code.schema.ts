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
import { SESSION_AUTH_TAG } from '#src/tags.js';

/**
 * Admin-console counterpart to `fetch-join-code`: mints/reuses a join code for
 * an arbitrary session on behalf of an authenticated operator. Unlike the
 * device-facing route (which requires a device token and room membership),
 * this is admin-key protected — only an authenticated operator ever sees a
 * code — which is what lets it skip the device-membership check entirely.
 *
 * Answers `200` with a `status` discriminant rather than a `409`/`404` for the
 * "expected" not-joinable cases (`not-active`, `no-join-scopes`): this route is
 * polled continuously by the admin console the same way `demo-room/status` is,
 * and a `status` field is simpler for the SPA to branch on than an HTTP status
 * code for states that aren't really errors.
 */
export const ADMIN_FETCH_JOIN_CODE_RESPONSE_SCHEMA = Type.Object(
  {
    status: Type.Union(
      [
        Type.Literal('ok'),
        Type.Literal('not-active'),
        Type.Literal('no-join-scopes'),
      ],
      {
        description:
          '`ok` — joinCode/validEnd are populated. `not-active` — the ' +
          'session exists but is outside its effective window. ' +
          "`no-join-scopes` — the session's joinCodeScopes is empty, so a " +
          'code could never be exchanged.',
      },
    ),
    joinCode: Type.Union([Type.String(), Type.Null()], {
      description: 'A currently-valid join code, or null unless status "ok".',
    }),
    validEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
      description: 'Expiry of `joinCode`, or null unless status "ok".',
    }),
  },
  { $id: 'AdminJoinCodeStatus' },
);

export const ADMIN_FETCH_JOIN_CODE_SCHEMA = {
  description:
    'Fetch/mint a currently-valid join code for a session, for the admin ' +
    'console to build a one-click "open live captions" link.',
  tags: [SESSION_AUTH_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: Type.Optional(ADMIN_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  body: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: ADMIN_FETCH_JOIN_CODE_RESPONSE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SESSION_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

export const ADMIN_FETCH_JOIN_CODE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/admin-fetch-join-code`,
};
