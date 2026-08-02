import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import {
  AUTH_CONFIG_ROUTE,
  AUTH_ME_ROUTE,
  LOGIN_ROUTE,
  LOGIN_SCHEMA,
  LOGOUT_ROUTE,
  SSO_CALLBACK_ROUTE,
  SSO_LOGIN_ROUTE,
} from './auth.schema.js';

export interface AuthRouterOptions {
  loginMax: number;
  loginWindowMs: number;
}

export function authRouter(
  fastify: BaseFastifyInstance,
  opts: AuthRouterOptions,
) {
  // Public: credential login. Stricter rate limit — the guessing surface.
  fastify.route({
    ...LOGIN_ROUTE,
    schema: { body: LOGIN_SCHEMA.body },
    config: {
      rateLimit: { max: opts.loginMax, timeWindow: opts.loginWindowMs },
    },
    handler: resolveHandler('authController', 'login'),
  });

  // Public: which providers are enabled.
  fastify.route({
    ...AUTH_CONFIG_ROUTE,
    handler: resolveHandler('authController', 'config'),
  });

  // Authenticated: current identity + CSRF token.
  fastify.route({
    ...AUTH_ME_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('authController', 'me'),
  });

  // Authenticated + CSRF: destroy the session.
  fastify.route({
    ...LOGOUT_ROUTE,
    preHandler: [requireSessionHook, csrfHook],
    handler: resolveHandler('authController', 'logout'),
  });

  // SSO routes: run the full OIDC flow when AZURE_* config is present, 404
  // SSO_NOT_AVAILABLE when it isn't. No rate limit (the redirect to Azure is
  // not a guessing surface), no session/CSRF preHandler (these are the
  // endpoints that *establish* a session).
  fastify.route({
    ...SSO_LOGIN_ROUTE,
    handler: resolveHandler('authController', 'ssoLogin'),
  });
  fastify.route({
    ...SSO_CALLBACK_ROUTE,
    handler: resolveHandler('authController', 'ssoCallback'),
  });
}
