/**
 * Defines a route on server
 */
interface BaseRouteSchema {
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

export type { BaseRouteSchema };
