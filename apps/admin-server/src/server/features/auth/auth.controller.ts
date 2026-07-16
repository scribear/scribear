import { setTimeout as sleep } from 'node:timers/promises';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
  sessionCookieOptions,
} from '#src/server/shared/http/cookie-options.js';

import type { LOGIN_SCHEMA } from './auth.schema.js';

// Fixed delay applied to failed logins to blunt online password guessing.
const FAILED_LOGIN_DELAY_MS = 400;

export class AuthController {
  private _localAuthService: AppDependencies['localAuthService'];
  private _azureOidcAuthService: AppDependencies['azureOidcAuthService'];
  private _sessionService: AppDependencies['sessionService'];
  private _auditService: AppDependencies['auditService'];

  constructor(
    localAuthService: AppDependencies['localAuthService'],
    azureOidcAuthService: AppDependencies['azureOidcAuthService'],
    sessionService: AppDependencies['sessionService'],
    auditService: AppDependencies['auditService'],
  ) {
    this._localAuthService = localAuthService;
    this._azureOidcAuthService = azureOidcAuthService;
    this._sessionService = sessionService;
    this._auditService = auditService;
  }

  /** Public: which auth providers are enabled, so the SPA renders the right UI. */
  config(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    res.code(200).send(
      okEnvelope({
        local: this._localAuthService.isEnabled(),
        sso: this._azureOidcAuthService.isEnabled(),
      }),
    );
  }

  async login(
    req: BaseFastifyRequest<typeof LOGIN_SCHEMA>,
    res: BaseFastifyReply,
  ) {
    if (!this._localAuthService.isEnabled()) {
      res
        .code(404)
        .send(
          errorEnvelope(
            'LOCAL_LOGIN_DISABLED',
            'Local login is not enabled on this deployment.',
            req.id,
          ),
        );
      return;
    }

    const { username, password } = req.body;
    const identity = this._localAuthService.verify(username, password);

    if (!identity) {
      await sleep(FAILED_LOGIN_DELAY_MS);
      await this._auditService.record({
        actorSubject: username.slice(0, 256),
        actorProvider: 'local',
        action: 'login',
        target: null,
        paramsSummary: { outcome: 'invalid-credentials' },
        result: 'failure',
        statusCode: 401,
        requestId: req.id,
      });
      // Generic message: never reveal whether the username or password was wrong.
      res
        .code(401)
        .send(
          errorEnvelope('INVALID_CREDENTIALS', 'Invalid credentials.', req.id),
        );
      return;
    }

    const { sessionId, csrfToken } = this._sessionService.create(identity);
    res.setCookie(
      SESSION_COOKIE_NAME,
      sessionId,
      sessionCookieOptions(
        this._sessionService.config.secure,
        this._sessionService.config.absoluteTimeoutMs,
      ),
    );

    await this._auditService.record({
      actorSubject: identity.subject,
      actorProvider: identity.provider,
      action: 'login',
      target: null,
      paramsSummary: { outcome: 'success' },
      result: 'success',
      statusCode: 200,
      requestId: req.id,
    });

    res.code(200).send(okEnvelope({ identity, csrfToken }));
  }

  async logout(req: BaseFastifyRequest, res: BaseFastifyReply) {
    const identity = req.adminIdentity;
    this._sessionService.destroy(req.adminSessionId);
    res.clearCookie(
      SESSION_COOKIE_NAME,
      clearSessionCookieOptions(this._sessionService.config.secure),
    );

    if (identity) {
      await this._auditService.record({
        actorSubject: identity.subject,
        actorProvider: identity.provider,
        action: 'logout',
        target: null,
        paramsSummary: {},
        result: 'success',
        statusCode: 200,
        requestId: req.id,
      });
    }

    res.code(200).send(okEnvelope(null));
  }

  /** Current identity + the session CSRF token (so the SPA can recover it after reload). */
  me(req: BaseFastifyRequest, res: BaseFastifyReply) {
    const session = req.adminSession;
    if (!session) {
      // Should never happen (guarded by requireSessionHook), but stay safe.
      res
        .code(401)
        .send(
          errorEnvelope('UNAUTHENTICATED', 'Authentication required.', req.id),
        );
      return;
    }
    res.code(200).send(
      okEnvelope({
        identity: session.identity,
        csrfToken: session.csrfToken,
      }),
    );
  }

  /** SSO stub: 404 until the Azure provider is configured + implemented. */
  ssoLogin(req: BaseFastifyRequest, res: BaseFastifyReply) {
    this._ssoNotAvailable(req, res);
  }

  ssoCallback(req: BaseFastifyRequest, res: BaseFastifyReply) {
    this._ssoNotAvailable(req, res);
  }

  private _ssoNotAvailable(req: BaseFastifyRequest, res: BaseFastifyReply) {
    res
      .code(404)
      .send(
        errorEnvelope(
          'SSO_NOT_AVAILABLE',
          'SSO is not configured on this deployment.',
          req.id,
        ),
      );
  }
}
