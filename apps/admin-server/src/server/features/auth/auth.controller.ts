import { timingSafeEqual } from 'node:crypto';
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
  SSO_STATE_COOKIE_NAME,
  clearSessionCookieOptions,
  clearSsoStateCookieOptions,
  sessionCookieOptions,
  ssoStateCookieOptions,
} from '#src/server/shared/http/cookie-options.js';
import { SsoError } from '#src/server/shared/services/azure-oidc-auth.service.js';

import type { LOGIN_SCHEMA } from './auth.schema.js';

// Fixed delay applied to failed logins to blunt online password guessing.
const FAILED_LOGIN_DELAY_MS = 400;

/**
 * Validates a `return_to` path so it can be safely used as a redirect target
 * after SSO. Must be a relative path within the admin SPA (`/admin...`) and
 * must not contain `//` (which could be a protocol-relative URL). Returns
 * `/admin/` (the dashboard) if the input is missing or invalid — never an
 * absolute URL, so there is no open-redirect surface.
 */
function sanitizeReturnTo(value: string | undefined): string {
  if (!value) return '/admin/';
  // Must be exactly '/admin' or start with '/admin/' — not '/adminXYZ',
  // which isn't a route under the admin SPA. And no '//' anywhere, which
  // could be a protocol-relative URL (open-redirect surface).
  if (value !== '/admin' && !value.startsWith('/admin/')) return '/admin/';
  if (value.includes('//')) return '/admin/';
  return value;
}

/**
 * Maps `SsoError` codes to the user-facing query parameter sent to the SPA
 * login page. The detailed code is logged/audited but never sent to the
 * browser — a generic param prevents information leakage about internal state.
 */
function ssoErrorToParam(code: SsoError['code']): string {
  switch (code) {
    case 'GROUP_REJECTED':
      return 'group_rejected';
    case 'GROUP_CLAIM_MISSING':
    case 'GROUP_OVERAGE':
      return 'config_error';
    case 'TOKEN_EXCHANGE_FAILED':
    case 'TOKEN_VALIDATION_FAILED':
      return 'auth_failed';
    default:
      return 'auth_failed';
  }
}

export class AuthController {
  private _localAuthService: AppDependencies['localAuthService'];
  private _azureOidcAuthService: AppDependencies['azureOidcAuthService'];
  private _sessionService: AppDependencies['sessionService'];
  private _auditService: AppDependencies['auditService'];
  private _grafanaEnabled: boolean;

  constructor(
    localAuthService: AppDependencies['localAuthService'],
    azureOidcAuthService: AppDependencies['azureOidcAuthService'],
    sessionService: AppDependencies['sessionService'],
    auditService: AppDependencies['auditService'],
    grafanaEnabled: boolean,
  ) {
    this._localAuthService = localAuthService;
    this._azureOidcAuthService = azureOidcAuthService;
    this._sessionService = sessionService;
    this._auditService = auditService;
    this._grafanaEnabled = grafanaEnabled;
  }

  /** Public: which auth providers are enabled, so the SPA renders the right UI. */
  config(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    res.code(200).send(
      okEnvelope({
        local: this._localAuthService.isEnabled(),
        sso: this._azureOidcAuthService.isEnabled(),
        grafana: this._grafanaEnabled,
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

  /**
   * SSO login entry point: generate a PKCE pair + CSRF state, store them in a
   * short-lived signed cookie, and redirect the browser to Azure's
   * authorization endpoint. The SPA triggers this with a full-page navigation
   * (not a fetch) — the redirect must be top-level so Azure's callback can
   * redirect back to the BFF.
   */
  ssoLogin(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._azureOidcAuthService.isEnabled()) {
      res
        .code(404)
        .send(
          errorEnvelope(
            'SSO_NOT_AVAILABLE',
            'SSO is not configured on this deployment.',
            req.id,
          ),
        );
      return;
    }

    const { url, state, codeVerifier, nonce } =
      this._azureOidcAuthService.buildAuthorizationUrl();

    // Capture the SPA deep link the user was on, so the callback can return
    // them there instead of always landing on the dashboard.
    const query = req.query as { return_to?: string };
    const returnTo = sanitizeReturnTo(query.return_to);

    res.setCookie(
      SSO_STATE_COOKIE_NAME,
      JSON.stringify({ state, codeVerifier, nonce, returnTo }),
      ssoStateCookieOptions(this._sessionService.config.secure),
    );

    res.redirect(url.toString());
  }

  /**
   * SSO callback: Azure redirects here with `?code=...&state=...`. Verify the
   * state against the cookie (CSRF), exchange the code for tokens, validate
   * the id_token, enforce the group allowlist, and issue a session. On any
   * failure, redirect to the login page with an error indicator — the SPA
   * renders the message.
   */
  async ssoCallback(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._azureOidcAuthService.isEnabled()) {
      res
        .code(404)
        .send(
          errorEnvelope(
            'SSO_NOT_AVAILABLE',
            'SSO is not configured on this deployment.',
            req.id,
          ),
        );
      return;
    }

    const secure = this._sessionService.config.secure;

    // Always clear the state cookie — it is one-time use.
    res.clearCookie(SSO_STATE_COOKIE_NAME, clearSsoStateCookieOptions(secure));

    const query = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    // Azure may redirect back with an error instead of a code.
    if (query.error) {
      await this._auditSsoFailure(
        req,
        'auth_failed',
        `Azure error: ${query.error}`,
      );
      res.redirect('/admin/login?sso_error=auth_failed');
      return;
    }

    // Read and verify the state cookie (CSRF defense for the OIDC flow).
    const rawCookie = req.unsignCookie(
      req.cookies[SSO_STATE_COOKIE_NAME] ?? '',
    );
    if (!rawCookie.valid || !rawCookie.value) {
      await this._auditSsoFailure(
        req,
        'state_error',
        'SSO state cookie missing or invalid',
      );
      res.redirect('/admin/login?sso_error=state_error');
      return;
    }

    let cookieState: string;
    let codeVerifier: string;
    let nonce: string;
    let returnTo: string;
    try {
      const parsed = JSON.parse(rawCookie.value) as {
        state: string;
        codeVerifier: string;
        nonce?: string;
        returnTo?: string;
      };
      cookieState = parsed.state;
      codeVerifier = parsed.codeVerifier;
      nonce = parsed.nonce ?? '';
      returnTo = sanitizeReturnTo(parsed.returnTo);
    } catch {
      await this._auditSsoFailure(
        req,
        'state_error',
        'SSO state cookie unparseable',
      );
      res.redirect('/admin/login?sso_error=state_error');
      return;
    }

    // Constant-time state comparison (defense-in-depth: the state is a
    // 256-bit random value in a signed cookie, so timing attacks are
    // impractical, but the cost is negligible).
    const queryState = query.state ?? '';
    if (
      queryState.length !== cookieState.length ||
      !timingSafeEqual(Buffer.from(queryState), Buffer.from(cookieState))
    ) {
      await this._auditSsoFailure(req, 'state_error', 'SSO state mismatch');
      res.redirect('/admin/login?sso_error=state_error');
      return;
    }

    if (!query.code) {
      await this._auditSsoFailure(
        req,
        'state_error',
        'SSO callback missing authorization code',
      );
      res.redirect('/admin/login?sso_error=state_error');
      return;
    }

    let identity;
    try {
      identity = await this._azureOidcAuthService.handleCallback(
        query.code,
        codeVerifier,
        nonce,
      );
    } catch (err) {
      if (err instanceof SsoError) {
        await this._auditSsoFailure(
          req,
          ssoErrorToParam(err.code),
          err.message,
        );
        res.redirect(`/admin/login?sso_error=${ssoErrorToParam(err.code)}`);
        return;
      }
      throw err;
    }

    const { sessionId } = this._sessionService.create(identity);
    res.setCookie(
      SESSION_COOKIE_NAME,
      sessionId,
      sessionCookieOptions(
        secure,
        this._sessionService.config.absoluteTimeoutMs,
      ),
    );

    await this._auditService.record({
      actorSubject: identity.subject,
      actorProvider: 'sso',
      action: 'login',
      target: null,
      paramsSummary: { outcome: 'success' },
      result: 'success',
      statusCode: 302,
      requestId: req.id,
    });

    res.redirect(returnTo);
  }

  private async _auditSsoFailure(
    req: BaseFastifyRequest,
    param: string,
    detail: string,
  ): Promise<void> {
    req.log.warn(
      { ssoError: param, detail, requestId: req.id },
      'SSO login failed',
    );
    await this._auditService.record({
      actorSubject: 'unknown',
      actorProvider: 'sso',
      action: 'login',
      target: null,
      paramsSummary: { outcome: param },
      result: 'failure',
      statusCode: 302,
      requestId: req.id,
    });
  }
}
