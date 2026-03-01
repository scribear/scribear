/**
 * Defines a route on server
 */
interface BaseRouteDefinition {
  method: 'GET' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'PATCH' | 'PUT' | 'POST';
  url: string;
}

export type { BaseRouteDefinition };
