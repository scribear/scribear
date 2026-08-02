import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  vi,
} from 'vitest';

import { AzureOidcAuthService } from '#src/server/shared/services/azure-oidc-auth.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const TEST_CONFIG = {
  tenantId: 'test-tenant-id',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.edu/api/admin/v1/auth/sso/callback',
  allowedGroup: 'group-aaa-111',
};

const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TEST_CONFIG.tenantId}/oauth2/v2.0/token`;
const JWKS_ENDPOINT = `https://login.microsoftonline.com/${TEST_CONFIG.tenantId}/discovery/v2.0/keys`;
const ISSUER = `https://login.microsoftonline.com/${TEST_CONFIG.tenantId}/v2.0`;

const TEST_NONCE = 'test-nonce-12345';

/**
 * Builds a signed test id_token (and its matching JWKS) so `jose`'s
 * `jwtVerify` + `createRemoteJWKSet` can validate it without a real Azure
 * endpoint. `fetch` is mocked to serve the JWKS at the discovery URL and the
 * token response at the token URL.
 */
async function buildTestToken(
  privateKey: CryptoKey,
  publicJwk: Record<string, unknown>,
  claims: Record<string, unknown>,
  nonce?: string,
): Promise<string> {
  const payload = nonce ? { ...claims, nonce } : claims;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(TEST_CONFIG.clientId)
    .setSubject(claims['sub'] as string)
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(privateKey);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('AzureOidcAuthService', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('isEnabled', (it) => {
    it('is enabled when all five config vars are set', () => {
      // Arrange
      const logger = createMockLogger();

      // Act
      const service = new AzureOidcAuthService(logger as never, TEST_CONFIG);

      // Assert
      expect(service.isEnabled()).toBe(true);
    });

    it('is disabled when tenantId is empty', () => {
      const service = new AzureOidcAuthService(createMockLogger() as never, {
        ...TEST_CONFIG,
        tenantId: '',
      });
      expect(service.isEnabled()).toBe(false);
    });

    it('is disabled when allowedGroup is empty', () => {
      const service = new AzureOidcAuthService(createMockLogger() as never, {
        ...TEST_CONFIG,
        allowedGroup: '',
      });
      expect(service.isEnabled()).toBe(false);
    });

    it('is disabled when redirectUri is empty', () => {
      const service = new AzureOidcAuthService(createMockLogger() as never, {
        ...TEST_CONFIG,
        redirectUri: '',
      });
      expect(service.isEnabled()).toBe(false);
    });

    it('is disabled when all vars are empty', () => {
      const service = new AzureOidcAuthService(createMockLogger() as never, {
        tenantId: '',
        clientId: '',
        clientSecret: '',
        redirectUri: '',
        allowedGroup: '',
      });
      expect(service.isEnabled()).toBe(false);
    });

    it('trims whitespace before checking', () => {
      const service = new AzureOidcAuthService(createMockLogger() as never, {
        ...TEST_CONFIG,
        allowedGroup: '  ',
      });
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('buildAuthorizationUrl', (it) => {
    it('builds a URL with all required OIDC params, PKCE, nonce, and Graph scope', () => {
      // Arrange
      const logger = createMockLogger();
      const service = new AzureOidcAuthService(logger as never, TEST_CONFIG);

      // Act
      const { url, state, codeVerifier, nonce } =
        service.buildAuthorizationUrl();

      // Assert — URL points to Azure's authorize endpoint
      expect(url.origin).toBe('https://login.microsoftonline.com');
      expect(url.pathname).toBe(
        `/${TEST_CONFIG.tenantId}/oauth2/v2.0/authorize`,
      );
      expect(url.searchParams.get('client_id')).toBe(TEST_CONFIG.clientId);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(
        TEST_CONFIG.redirectUri,
      );
      expect(url.searchParams.get('scope')).toBe(
        'openid profile email https://graph.microsoft.com/.default',
      );
      expect(url.searchParams.get('state')).toBe(state);
      expect(url.searchParams.get('nonce')).toBe(nonce);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      // PKCE: the challenge is the SHA-256 hash of the verifier (base64url)
      const expectedChallenge = createHash('sha256')
        .update(codeVerifier, 'ascii')
        .digest('base64url');
      expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge);

      // State, verifier, and nonce are non-empty random strings, all distinct
      expect(state.length).toBeGreaterThan(0);
      expect(codeVerifier.length).toBeGreaterThan(0);
      expect(nonce.length).toBeGreaterThan(0);
      expect(state).not.toBe(codeVerifier);
      expect(state).not.toBe(nonce);
      expect(codeVerifier).not.toBe(nonce);
    });

    it('generates a different state, verifier, and nonce on each call', () => {
      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );
      const a = service.buildAuthorizationUrl();
      const b = service.buildAuthorizationUrl();
      expect(a.state).not.toBe(b.state);
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.nonce).not.toBe(b.nonce);
    });
  });

  describe('handleCallback', (it) => {
    let testPrivateKey: CryptoKey;
    let testPublicJwk: Record<string, unknown>;

    beforeEach(async () => {
      const pair = await generateKeyPair('RS256');
      testPrivateKey = pair.privateKey;
      const jwk = await exportJWK(pair.publicKey);
      testPublicJwk = { ...jwk, kid: 'test-kid' };
    });

    const GRAPH_ENDPOINT =
      'https://graph.microsoft.com/v1.0/me/checkMemberGroups';

    /**
     * Wires `fetch` to return a token response (with the given id_token) at
     * the token endpoint and the test JWKS at the discovery/keys endpoint.
     * Optionally also mocks the Graph API checkMemberGroups endpoint for the
     * overage fallback path.
     */
    function mockFetchForToken(
      idToken: string,
      graphResult?: { member: boolean } | { errorStatus: number },
    ): void {
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
                access_token: 'test-access-token',
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
        if (url === GRAPH_ENDPOINT) {
          if (graphResult && 'errorStatus' in graphResult) {
            return Promise.resolve(
              new Response('{"error":{"code":"Authorization_RequestDenied"}}', {
                status: graphResult.errorStatus,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          const member =
            graphResult && 'member' in graphResult ? graphResult.member : false;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                value: member ? [TEST_CONFIG.allowedGroup] : [],
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

    it('returns an Identity with provider=sso when the code, token, and group are valid', async () => {
      // Arrange
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-123',
          name: 'Jane Engineer',
          preferred_username: 'jane@illinois.edu',
          groups: [TEST_CONFIG.allowedGroup],
        },
        TEST_NONCE,
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      // Act
      const identity = await service.handleCallback(
        'test-code',
        'test-verifier',
        TEST_NONCE,
      );

      // Assert
      expect(identity).toStrictEqual({
        subject: 'azure-oid-123',
        displayName: 'Jane Engineer',
        provider: 'sso',
        roles: ['read-write'],
      });

      // The token endpoint was called with the code and verifier
      const tokenCall = fetchSpy.mock.calls.find(
        (c) => (c[0] as string) === TOKEN_ENDPOINT,
      );
      expect(tokenCall).toBeDefined();
      const body = (tokenCall![1]?.body as string) || '';
      expect(body).toContain('code=test-code');
      expect(body).toContain('code_verifier=test-verifier');
    });

    it('falls back to preferred_username when name claim is absent', async () => {
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-456',
          preferred_username: 'jane@illinois.edu',
          groups: [TEST_CONFIG.allowedGroup],
        },
        TEST_NONCE,
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      const identity = await service.handleCallback(
        'code',
        'verifier',
        TEST_NONCE,
      );

      expect(identity.displayName).toBe('jane@illinois.edu');
    });

    it('falls back to sub when both name and preferred_username are absent', async () => {
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-789',
          groups: [TEST_CONFIG.allowedGroup],
        },
        TEST_NONCE,
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      const identity = await service.handleCallback(
        'code',
        'verifier',
        TEST_NONCE,
      );

      expect(identity.displayName).toBe('azure-oid-789');
    });

    it('throws GROUP_REJECTED when the user is not in the allowed group', async () => {
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-no',
          name: 'Unauthorized User',
          groups: ['some-other-group'],
        },
        TEST_NONCE,
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'GROUP_REJECTED',
        name: 'SsoError',
      });
    });

    it('throws GROUP_CLAIM_MISSING when the groups claim is absent', async () => {
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-nogroup',
          name: 'No Groups',
        },
        TEST_NONCE,
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'GROUP_CLAIM_MISSING',
      });
    });

    it('falls back to Graph API on overage and succeeds when the user is a member', async () => {
      const overageClaims: Record<string, unknown> = {
        sub: 'azure-oid-overage',
        name: 'Overage User',
      };
      overageClaims['_claim_names'] = { groups: 'src1' };
      overageClaims['_claim_sources'] = {
        src1: { endpoint: 'https://graph.microsoft.com/...' },
      };
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        overageClaims,
        TEST_NONCE,
      );
      mockFetchForToken(idToken, { member: true });

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      const identity = await service.handleCallback(
        'code',
        'verifier',
        TEST_NONCE,
      );

      expect(identity.subject).toBe('azure-oid-overage');
      expect(identity.provider).toBe('sso');
    });

    it('falls back to Graph API on overage and rejects when the user is not a member', async () => {
      const overageClaims: Record<string, unknown> = {
        sub: 'azure-oid-overage-no',
        name: 'Overage Non-Member',
      };
      overageClaims['_claim_names'] = { groups: 'src1' };
      overageClaims['_claim_sources'] = {
        src1: { endpoint: 'https://graph.microsoft.com/...' },
      };
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        overageClaims,
        TEST_NONCE,
      );
      mockFetchForToken(idToken, { member: false });

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'GROUP_REJECTED',
      });
    });

    it('throws GROUP_OVERAGE when the Graph API returns an error (insufficient permissions)', async () => {
      const overageClaims: Record<string, unknown> = {
        sub: 'azure-oid-overage-403',
        name: 'Overage No Perm',
      };
      overageClaims['_claim_names'] = { groups: 'src1' };
      overageClaims['_claim_sources'] = {
        src1: { endpoint: 'https://graph.microsoft.com/...' },
      };
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        overageClaims,
        TEST_NONCE,
      );
      mockFetchForToken(idToken, { errorStatus: 403 });

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'GROUP_OVERAGE',
      });
    });

    it('throws TOKEN_EXCHANGE_FAILED when the token endpoint returns an error', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('bad-code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_EXCHANGE_FAILED',
      });
    });

    it('throws TOKEN_EXCHANGE_FAILED when fetch throws a network error', async () => {
      fetchSpy.mockImplementation(() => {
        throw new Error('ECONNREFUSED');
      });

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_EXCHANGE_FAILED',
      });
    });

    it('throws TOKEN_VALIDATION_FAILED when the id_token signature is invalid', async () => {
      // Sign with a different key pair than the JWKS advertises
      const otherPair = await generateKeyPair('RS256');
      const idToken = await buildTestToken(
        otherPair.privateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-fake',
          name: 'Fake Signature',
          groups: [TEST_CONFIG.allowedGroup],
        },
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_VALIDATION_FAILED',
      });
    });

    it('throws TOKEN_VALIDATION_FAILED when the id_token is missing from the response', async () => {
      fetchSpy.mockImplementation((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url === TOKEN_ENDPOINT) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'only-access' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      });

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_VALIDATION_FAILED',
      });
    });

    it('throws TOKEN_VALIDATION_FAILED when the issuer is wrong', async () => {
      const idToken = await new SignJWT({
        sub: 'azure-oid-wrong-iss',
        name: 'Wrong Issuer',
        groups: [TEST_CONFIG.allowedGroup],
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
        .setIssuer('https://login.microsoftonline.com/wrong-tenant/v2.0')
        .setAudience(TEST_CONFIG.clientId)
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(testPrivateKey);
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_VALIDATION_FAILED',
      });
    });

    it('throws TOKEN_VALIDATION_FAILED when the nonce does not match', async () => {
      // Token signed with a different nonce than the one expected
      const idToken = await buildTestToken(
        testPrivateKey,
        testPublicJwk,
        {
          sub: 'azure-oid-nonce-mismatch',
          name: 'Nonce Mismatch',
          groups: [TEST_CONFIG.allowedGroup],
        },
        'wrong-nonce',
      );
      mockFetchForToken(idToken);

      const service = new AzureOidcAuthService(
        createMockLogger() as never,
        TEST_CONFIG,
      );

      await expect(
        service.handleCallback('code', 'verifier', TEST_NONCE),
      ).rejects.toMatchObject({
        code: 'TOKEN_VALIDATION_FAILED',
      });
    });
  });
});
