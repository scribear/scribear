import {
  assertNotPlaceholderKey,
  constantTimeEqual,
} from '#src/server/utils/constant-time-equal.js';

const BEARER_PREFIX = 'Bearer ';

export interface ServiceAuthConfig {
  serviceApiKey: string;
}

export class ServiceAuthService {
  private _serviceAuthConfig: ServiceAuthConfig;

  constructor(serviceAuthConfig: ServiceAuthConfig) {
    assertNotPlaceholderKey(
      serviceAuthConfig.serviceApiKey,
      'SESSION_MANAGER_SERVICE_API_KEY',
    );
    this._serviceAuthConfig = serviceAuthConfig;
  }

  /**
   * Strips the `Bearer ` prefix and compares the remaining key to the
   * configured service API key in constant time.
   * @param authorizationHeader The raw `Authorization` header value.
   */
  isValid(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;
    const key = authorizationHeader.slice(BEARER_PREFIX.length);
    return constantTimeEqual(key, this._serviceAuthConfig.serviceApiKey);
  }
}
