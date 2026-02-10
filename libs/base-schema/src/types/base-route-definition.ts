/**
 * Defines a route on server
 */
interface BaseRouteDefinition {
  method:
    | 'GET'
    | 'HEAD'
    | 'TRACE'
    | 'DELETE'
    | 'OPTIONS'
    | 'PATCH'
    | 'PUT'
    | 'POST';

  url: string;
}

export type { BaseRouteDefinition };
