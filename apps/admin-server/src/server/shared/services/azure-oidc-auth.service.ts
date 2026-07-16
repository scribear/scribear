import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface AzureAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedGroup: string;
}

/**
 * Stub for the future Azure Entra ID (OIDC, Auth Code + PKCE) provider. The
 * seams are in place so it drops in later without reworking session/CSRF/audit:
 * everything downstream sees only an `Identity`.
 *
 * Enabled only when all required `AZURE_*` config is present. Until then
 * `isEnabled()` is false and `/auth/config` reports `sso: false`.
 */
export class AzureOidcAuthService {
  readonly id = 'sso' as const;

  private _enabled: boolean;

  constructor(azureAuthConfig: AppDependencies['azureAuthConfig']) {
    const cfg = azureAuthConfig;
    this._enabled =
      cfg.tenantId.trim() !== '' &&
      cfg.clientId.trim() !== '' &&
      cfg.clientSecret.trim() !== '' &&
      cfg.redirectUri.trim() !== '';
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  // Intentionally not implemented yet. The route handlers guard on
  // `isEnabled()` and return 404 while disabled; wiring the real OIDC flow
  // (buildAuthorizationUrl / handleCallback -> Identity) happens here.
}
