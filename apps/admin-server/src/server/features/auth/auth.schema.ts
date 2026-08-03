import { Type } from 'typebox';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

export const LOGIN_SCHEMA = {
  body: Type.Object(
    {
      username: Type.String({ minLength: 1, maxLength: 256 }),
      // Cap length to bound hashing work on unauthenticated input.
      password: Type.String({ minLength: 1, maxLength: 1024 }),
    },
    { additionalProperties: false },
  ),
};

export const LOGIN_ROUTE = {
  method: 'POST' as const,
  url: `${ADMIN_BASE_PATH}/auth/login`,
};

export const LOGOUT_ROUTE = {
  method: 'POST' as const,
  url: `${ADMIN_BASE_PATH}/auth/logout`,
};

export const AUTH_CONFIG_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/auth/config`,
};

export const AUTH_ME_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/auth/me`,
};

export const SSO_LOGIN_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/auth/sso/login`,
};

export const SSO_CALLBACK_ROUTE = {
  method: 'GET' as const,
  url: `${ADMIN_BASE_PATH}/auth/sso/callback`,
};
