/**
 * Defines a route on server
 */
interface BaseRouteDefinition {
  method: 'GET' | 'HEAD' | 'DELETE' | 'OPTIONS' | 'PATCH' | 'PUT' | 'POST';
  websocket?: boolean;
  url: string;
}

export type { BaseRouteDefinition };
