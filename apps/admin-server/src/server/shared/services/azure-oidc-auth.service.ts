import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { Identity } from '../types/identity.js';
import { ROLE_READ_WRITE } from '../types/identity.js';

export interface AzureAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedGroup: string;
}

/**
 * Error thrown by `handleCallback` on any failure. The `code` is a stable
 * machine-readable string the controller maps to a user-facing redirect
 * parameter; `message` is for logs/audit and is never sent to the browser.
 */
export class SsoError extends Error {
  readonly code: SsoErrorCode;
  constructor(code: SsoErrorCode, message: string) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
  }
}

export type SsoErrorCode =
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_VALIDATION_FAILED'
  | 'GROUP_CLAIM_MISSING'
  | 'GROUP_OVERAGE'
  | 'GROUP_REJECTED';

/**
 * Azure Entra ID (OIDC) auth provider — Authorization Code + PKCE.
 *
 * Enabled only when ALL five `AZURE_*` config vars are present (including
 * `allowedGroup`). Until then `isEnabled()` is false, `/auth/config` reports
 * `sso: false`, and the SSO routes return 404. An empty `allowedGroup` would
 * let any tenant user administer the deployment, so fail-closed is the only
 * safe default — the Config Check's `sso-no-group-restriction` critical
 * finding enforces the same thing at the reporting layer.
 *
 * Everything downstream of authentication (session, CSRF, audit) sees only an
 * `Identity`, never an Azure-specific credential — the pluggable-provider
 * design from `archived-plans/2026-07-15-01-PLAN-ADMIN.md` §4.4.
 */
export class AzureOidcAuthService {
  readonly id = 'sso' as const;

  private _enabled: boolean;
  private _tenantId: string;
  private _clientId: string;
  private _clientSecret: string;
  private _redirectUri: string;
  private _allowedGroup: string;
  private _issuer: string;
  private _jwks: ReturnType<typeof createRemoteJWKSet>;
  private _logger: AppDependencies['logger'];

  constructor(
    logger: AppDependencies['logger'],
    azureAuthConfig: AppDependencies['azureAuthConfig'],
  ) {
    this._logger = logger;
    const cfg = azureAuthConfig;
    this._tenantId = cfg.tenantId.trim();
    this._clientId = cfg.clientId.trim();
    this._clientSecret = cfg.clientSecret.trim();
    this._redirectUri = cfg.redirectUri.trim();
    this._allowedGroup = cfg.allowedGroup.trim();

    const configured =
      this._tenantId !== '' &&
      this._clientId !== '' &&
      this._clientSecret !== '' &&
      this._redirectUri !== '' &&
      this._allowedGroup !== '';

    this._enabled = configured;
    this._issuer = `https://login.microsoftonline.com/${this._tenantId}/v2.0`;
    this._jwks = createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${this._tenantId}/discovery/v2.0/keys`,
      ),
    );
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Build the Azure authorization URL and generate the PKCE pair + CSRF state
   * + OIDC nonce. The controller stores `{ state, codeVerifier, nonce }` in a
   * signed short-lived cookie and redirects the browser to `url`.
   *
   * The scope includes `https://graph.microsoft.com/.default` so the
   * `access_token` carries whatever Graph API delegated permissions have been
   * admin-consented on the app registration — needed by the group-overage
   * fallback (`_checkGroupViaGraph`). Without it, Azure AD v2.0's per-request
   * consent model would issue a token with only `openid profile email` and no
   * Graph permission, making every overage-fallback call 403.
   */
  buildAuthorizationUrl(): {
    url: URL;
    state: string;
    codeVerifier: string;
    nonce: string;
  } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier, 'ascii')
      .digest('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');

    const url = new URL(
      `https://login.microsoftonline.com/${this._tenantId}/oauth2/v2.0/authorize`,
    );
    url.searchParams.set('client_id', this._clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this._redirectUri);
    url.searchParams.set(
      'scope',
      'openid profile email https://graph.microsoft.com/.default',
    );
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { url, state, codeVerifier, nonce };
  }

  /**
   * Exchange the authorization code for tokens, validate the `id_token`,
   * enforce the group allowlist, and return an `Identity`. Throws `SsoError`
   * on any failure — the controller catches it and maps `code` to a redirect.
   *
   * Group authorization checks the `groups` claim in the `id_token` first.
   * When Azure emits an overage indicator (user has >200 groups, so the
   * `groups` claim is replaced by `_claim_names`/`_claim_sources`), this falls
   * back to the Microsoft Graph API `checkMemberGroups` endpoint using the
   * `access_token` from the token response — so the operator does not have to
   * configure "groups assigned to the application" in Azure as long as the
   * app registration has delegated `Directory.Read.All` or
   * `GroupMember.Read.All` permission with admin consent.
   */
  async handleCallback(
    code: string,
    codeVerifier: string,
    expectedNonce: string,
  ): Promise<Identity> {
    const tokenResponse = await this._exchangeCode(code, codeVerifier);
    const idToken = tokenResponse.id_token;
    if (!idToken) {
      throw new SsoError(
        'TOKEN_VALIDATION_FAILED',
        'Token endpoint did not return an id_token.',
      );
    }

    const claims = await this._validateIdToken(idToken, expectedNonce);
    await this._authorizeGroup(claims, tokenResponse.access_token);

    const subject = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    const displayName =
      typeof claims['name'] === 'string'
        ? claims['name']
        : typeof claims['preferred_username'] === 'string'
          ? claims['preferred_username']
          : subject;

    return {
      subject,
      displayName,
      provider: 'sso',
      roles: [ROLE_READ_WRITE],
    };
  }

  private async _exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<TokenEndpointResponse> {
    const body = new URLSearchParams({
      client_id: this._clientId,
      client_secret: this._clientSecret,
      code,
      redirect_uri: this._redirectUri,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    });

    let res: Response;
    try {
      res = await fetch(
        `https://login.microsoftonline.com/${this._tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        },
      );
    } catch (err) {
      throw new SsoError(
        'TOKEN_EXCHANGE_FAILED',
        `Network error during token exchange: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SsoError(
        'TOKEN_EXCHANGE_FAILED',
        `Token endpoint returned ${String(res.status)}: ${text.slice(0, 500)}`,
      );
    }

    try {
      return (await res.json()) as TokenEndpointResponse;
    } catch (err) {
      throw new SsoError(
        'TOKEN_EXCHANGE_FAILED',
        `Failed to parse token endpoint response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _validateIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<Record<string, unknown>> {
    try {
      const { payload } = await jwtVerify(idToken, this._jwks, {
        issuer: this._issuer,
        audience: this._clientId,
      });

      // OIDC nonce check: binds this id_token to the specific authorization
      // request that initiated the flow, preventing ID-token replay. The
      // nonce was generated in buildAuthorizationUrl, stored in the signed
      // sso_state cookie, and sent to Azure as the `nonce` param — Azure
      // echoes it back unmodified in the id_token's `nonce` claim.
      const tokenNonce = payload['nonce'];
      if (
        typeof tokenNonce !== 'string' ||
        tokenNonce.length !== expectedNonce.length ||
        !timingSafeEqual(Buffer.from(tokenNonce), Buffer.from(expectedNonce))
      ) {
        throw new SsoError(
          'TOKEN_VALIDATION_FAILED',
          'id_token nonce mismatch — possible replay attack.',
        );
      }

      return payload;
    } catch (err) {
      if (err instanceof SsoError) throw err;
      throw new SsoError(
        'TOKEN_VALIDATION_FAILED',
        `id_token validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _authorizeGroup(
    claims: Record<string, unknown>,
    accessToken: string | undefined,
  ): Promise<void> {
    // Azure emits an overage indicator when the user has >200 groups, instead
    // of the groups array. Fall back to the Graph API's checkMemberGroups
    // endpoint using the access_token — this requires the app registration to
    // have delegated Directory.Read.All or GroupMember.Read.All permission
    // with admin consent. If the app is configured with "groups assigned to
    // the application" in Azure, the overage indicator never appears and this
    // path is not reached.
    if ('_claim_names' in claims || '_claim_sources' in claims) {
      await this._checkGroupViaGraph(accessToken);
      return;
    }

    const groups = claims['groups'];
    if (!Array.isArray(groups)) {
      throw new SsoError(
        'GROUP_CLAIM_MISSING',
        'id_token has no groups claim. Configure the app registration to emit the groups claim.',
      );
    }

    if (!groups.includes(this._allowedGroup)) {
      throw new SsoError(
        'GROUP_REJECTED',
        `User is not a member of the allowed group (${this._allowedGroup}).`,
      );
    }
  }

  /**
   * Graph API fallback for the group overage case. Calls
   * `checkMemberGroups` with the `access_token` to test membership in
   * `allowedGroup` without relying on the `groups` claim.
   */
  private async _checkGroupViaGraph(
    accessToken: string | undefined,
  ): Promise<void> {
    if (!accessToken) {
      throw new SsoError(
        'GROUP_OVERAGE',
        'Group overage detected but no access_token was returned by the token endpoint ' +
          'to call the Graph API fallback. Configure "groups assigned to the application" in Azure.',
      );
    }

    let res: Response;
    try {
      res = await fetch(
        'https://graph.microsoft.com/v1.0/me/checkMemberGroups',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ groupIds: [this._allowedGroup] }),
        },
      );
    } catch (err) {
      throw new SsoError(
        'GROUP_OVERAGE',
        `Graph API call failed during group overage fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SsoError(
        'GROUP_OVERAGE',
        `Graph API returned ${String(res.status)}: ${text.slice(0, 500)}. ` +
          'The app registration may need delegated Directory.Read.All or GroupMember.Read.All permission with admin consent, ' +
          'or configure "groups assigned to the application" in Azure to avoid overage.',
      );
    }

    try {
      const body = (await res.json()) as { value?: string[] };
      if (!body.value?.includes(this._allowedGroup)) {
        throw new SsoError(
          'GROUP_REJECTED',
          `User is not a member of the allowed group (${this._allowedGroup}).`,
        );
      }
    } catch (err) {
      if (err instanceof SsoError) throw err;
      throw new SsoError(
        'GROUP_OVERAGE',
        `Failed to parse Graph API response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface TokenEndpointResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}
