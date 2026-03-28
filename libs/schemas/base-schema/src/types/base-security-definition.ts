/**
 * OpenAPI security schema definition types
 */
interface SharedSecurity {
  type: string;
  description?: string;
}

interface ApiKeySecurity extends SharedSecurity {
  type: 'apiKey';
  in: 'query' | 'header' | 'cookie';
  name: string;
}

interface HttpSecurity extends SharedSecurity {
  type: 'http';
  scheme: string;
  bearerFormat?: string;
}

interface MutualTLSSecurity extends SharedSecurity {
  type: 'mutualTLS';
}

interface OAuthImplicitFlow {
  authorizationUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

interface OAuthPasswordFlow {
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

interface OAuthClientCredentialsFlow {
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

interface OAuthAuthorizationCodeFlow {
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

interface OAuthFlows {
  implicit?: OAuthImplicitFlow;
  password?: OAuthPasswordFlow;
  clientCredentials?: OAuthClientCredentialsFlow;
  authorizationCode?: OAuthAuthorizationCodeFlow;
}

interface OAuth2Security extends SharedSecurity {
  type: 'oauth2';
  flows: OAuthFlows;
}

interface OpenIdConnectSecurity extends SharedSecurity {
  type: 'openIdConnect';
  openIdConnectUrl: string;
}

export type BaseSecurityDefinition = Record<
  string,
  | ApiKeySecurity
  | HttpSecurity
  | MutualTLSSecurity
  | OAuth2Security
  | OpenIdConnectSecurity
>;
