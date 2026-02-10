/**
 * OpenAPI security schema definition types
 */
interface SharedSecurity {
  type: string;
  description: string;
}

interface BasicSecurity extends SharedSecurity {
  type: 'basic';
}

interface ApiKeySecurity extends SharedSecurity {
  type: 'apiKey';
  in: 'query' | 'header';
  name: string;
}

interface SharedOAuth2Security extends SharedSecurity {
  type: 'oauth2';
  flow: string;
  scopes: Record<string, string>;
}

interface OAuth2AuthorizationUrlSecurity extends SharedOAuth2Security {
  flow: 'implicit' | 'accessCode';
  authorizationUrl: string;
}

interface OAuth2TokenUrlSecurity extends SharedOAuth2Security {
  flow: 'password' | 'application' | 'accessCode';
  tokenUrl: string;
}

export type BaseSecurityDefinition = Record<
  string,
  | BasicSecurity
  | ApiKeySecurity
  | OAuth2AuthorizationUrlSecurity
  | OAuth2TokenUrlSecurity
>;
