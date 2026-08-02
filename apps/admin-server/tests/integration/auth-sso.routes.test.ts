import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  type MockInstance,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
} from 'vitest';

import { useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';

const SSO_CONFIG = {
  tenantId: 'test-tenant',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.edu/api/admin/v1/auth/sso/callback',
  allowedGroup: 'admin-group-aaa',
};

const ISSUER = `https://login.microsoftonline.com/${SSO_CONFIG.tenantId}/v2.0`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${SSO_CONFIG.tenantId}/oauth2/v2.0/token`;
const JWKS_ENDPOINT = `https://login.microsoftonline.com/${SSO_CONFIG.tenantId}/discovery/v2.0/keys`;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('Auth SSO routes — disabled (default config)', () => {
  const server = useServer();

  describe('GET /auth/sso/login', (it) => {
    it('returns 404 SSO_NOT_AVAILABLE when SSO is not configured', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/login`,
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'SSO_NOT_AVAILABLE',
      );
    });
  });

  describe('GET /auth/sso/callback', (it) => {
    it('returns 404 SSO_NOT_AVAILABLE when SSO is not configured', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=x&state=y`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'SSO_NOT_AVAILABLE',
      );
    });
  });
});

describe('Auth SSO routes — enabled', () => {
  const server = useServer({ azureAuthConfig: SSO_CONFIG });

  let testPrivateKey: CryptoKey;
  let testPublicJwk: Record<string, unknown>;
  let fetchSpy: MockInstance;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    testPrivateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    testPublicJwk = { ...jwk, kid: 'test-kid' };
  });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockTokenEndpoint(idToken: string): void {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === JWKS_ENDPOINT) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [testPublicJwk] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url === TOKEN_ENDPOINT) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id_token: idToken,
              access_token: 'test-access',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
  }

  async function signTestToken(
    claims: Record<string, unknown>,
    nonce?: string,
  ): Promise<string> {
    const payload = nonce ? { ...claims, nonce } : claims;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(SSO_CONFIG.clientId)
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(testPrivateKey);
  }

  /**
   * Drives the login redirect to extract the sso_state cookie and the state
   * and nonce params, so the callback test can present them as a browser
   * would. The nonce is visible in the redirect URL (not in the signed
   * cookie), so it can be extracted and baked into the test id_token.
   */
  async function startSsoLogin(returnTo?: string): Promise<{
    cookie: string;
    state: string;
    nonce: string;
  }> {
    const url = returnTo
      ? `${BASE}/auth/sso/login?return_to=${encodeURIComponent(returnTo)}`
      : `${BASE}/auth/sso/login`;
    const res = await server.fastify.inject({
      method: 'GET',
      url,
    });

    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain('login.microsoftonline.com');

    // Extract the state and nonce from the redirect URL's query params.
    const redirectUrl = new URL(location);
    const state = redirectUrl.searchParams.get('state');
    const nonce = redirectUrl.searchParams.get('nonce');
    expect(state).toBeTruthy();
    expect(nonce).toBeTruthy();

    // Extract the sso_state cookie pair (name=value only).
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie)
      ? (setCookie[0] ?? '')
      : (setCookie ?? '');
    const cookiePair = raw.split(';')[0] ?? '';

    return { cookie: cookiePair, state: state!, nonce: nonce! };
  }

  describe('GET /auth/config', (it) => {
    it('reports sso enabled alongside local', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/config`,
      });
      expect(res.json()).toEqual({
        ok: true,
        data: { local: true, sso: true },
      });
    });
  });

  describe('GET /auth/sso/login', (it) => {
    it('redirects to Azure with PKCE challenge and sets a signed sso_state cookie', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/login`,
      });

      // Assert
      expect(res.statusCode).toBe(302);
      const location = new URL(String(res.headers.location));
      expect(location.origin).toBe('https://login.microsoftonline.com');
      expect(location.pathname).toBe(
        `/${SSO_CONFIG.tenantId}/oauth2/v2.0/authorize`,
      );
      expect(location.searchParams.get('client_id')).toBe(SSO_CONFIG.clientId);
      expect(location.searchParams.get('response_type')).toBe('code');
      expect(location.searchParams.get('redirect_uri')).toBe(
        SSO_CONFIG.redirectUri,
      );
      expect(location.searchParams.get('scope')).toBe(
        'openid profile email https://graph.microsoft.com/.default',
      );
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('code_challenge')).toBeTruthy();
      expect(location.searchParams.get('state')).toBeTruthy();
      expect(location.searchParams.get('nonce')).toBeTruthy();

      // A signed sso_state cookie is set.
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('sso_state=');
      expect(setCookie.toLowerCase()).toContain('httponly');
      expect(setCookie.toLowerCase()).toContain('samesite=lax');
    });
  });

  describe('GET /auth/sso/callback', (it) => {
    it('creates a session and redirects to /admin/ on a valid callback', async () => {
      // Arrange — start the SSO login to get the state cookie
      const { cookie, state, nonce } = await startSsoLogin();

      const idToken = await signTestToken(
        {
          sub: 'azure-user-001',
          name: 'Test Admin',
          groups: [SSO_CONFIG.allowedGroup],
        },
        nonce,
      );
      mockTokenEndpoint(idToken);

      // Act — simulate Azure redirecting back with code + state
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=${state}`,
        headers: { cookie },
      });

      // Assert — redirected to the SPA root with a session cookie
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/');

      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toContain('admin_session=');
      // The sso_state cookie is cleared (one-time use).
      expect(setCookie.toLowerCase()).toContain('sso_state=');
      expect(setCookie.toLowerCase()).toContain('expires=thu, 01 jan 1970');

      // The session is usable: /auth/me returns the SSO identity.
      const sessionCookie = setCookie
        .split(',')
        .find((c) => c.trim().startsWith('admin_session='));
      const cookiePair = (sessionCookie ?? '').split(';')[0] ?? '';
      const meRes = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/me`,
        headers: { cookie: cookiePair },
      });
      expect(meRes.statusCode).toBe(200);
      const me = meRes.json<{
        data: { identity: { subject: string; provider: string } };
      }>();
      expect(me.data.identity.subject).toBe('azure-user-001');
      expect(me.data.identity.provider).toBe('sso');
    });

    it('redirects with sso_error=group_rejected when the user is not in the allowed group', async () => {
      const { cookie, state, nonce } = await startSsoLogin();

      const idToken = await signTestToken(
        {
          sub: 'azure-user-no-group',
          name: 'Unauthorized',
          groups: ['some-other-group'],
        },
        nonce,
      );
      mockTokenEndpoint(idToken);

      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=${state}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        '/admin/login?sso_error=group_rejected',
      );
      // No session cookie issued.
      const setCookie = String(res.headers['set-cookie'] ?? '');
      expect(setCookie).not.toContain('admin_session=');
    });

    it('redirects with sso_error=state_error when the state cookie is missing', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=anything`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/login?sso_error=state_error');
    });

    it('redirects with sso_error=state_error when the state does not match', async () => {
      const { cookie } = await startSsoLogin();

      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=wrong-state`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/login?sso_error=state_error');
    });

    it('redirects with sso_error=auth_failed when Azure sends an error param', async () => {
      const { cookie, state } = await startSsoLogin();

      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?error=access_denied&state=${state}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/login?sso_error=auth_failed');
    });

    it('preserves a deep link through the SSO flow via return_to', async () => {
      // Arrange — start SSO login with a return_to deep link
      const { cookie, state, nonce } = await startSsoLogin('/admin/rooms/123');

      const idToken = await signTestToken(
        {
          sub: 'azure-deep-link',
          name: 'Deep Link User',
          groups: [SSO_CONFIG.allowedGroup],
        },
        nonce,
      );
      mockTokenEndpoint(idToken);

      // Act — callback with the state cookie
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=${state}`,
        headers: { cookie },
      });

      // Assert — redirected to the deep link, not the dashboard
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/rooms/123');
    });

    it('sanitizes a malicious return_to (absolute URL) to /admin/', async () => {
      const { cookie, state, nonce } = await startSsoLogin(
        'https://evil.com/admin/',
      );

      const idToken = await signTestToken(
        {
          sub: 'azure-sanitize',
          name: 'Sanitize User',
          groups: [SSO_CONFIG.allowedGroup],
        },
        nonce,
      );
      mockTokenEndpoint(idToken);

      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/auth/sso/callback?code=test-code&state=${state}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin/');
    });
  });
});
