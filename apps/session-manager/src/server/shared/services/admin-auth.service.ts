import {
  assertNotPlaceholderKey,
  constantTimeEqual,
} from '#src/server/utils/constant-time-equal.js';

const BEARER_PREFIX = 'Bearer ';

export interface AdminAuthConfig {
  adminApiKey: string;
}

export class AdminAuthService {
  private _adminAuthConfig: AdminAuthConfig;

  constructor(adminAuthConfig: AdminAuthConfig) {
    assertNotPlaceholderKey(adminAuthConfig.adminApiKey, 'ADMIN_API_KEY');
    this._adminAuthConfig = adminAuthConfig;
  }

  /**
   * Strips the `Bearer ` prefix and compares the remaining key to the
   * configured API key in constant time.
   * @param authorizationHeader The raw `Authorization` header value.
   */
  isValid(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;
    const key = authorizationHeader.slice(BEARER_PREFIX.length);
    return constantTimeEqual(key, this._adminAuthConfig.adminApiKey);
  }
}
