type HttpStatusCode =
  | 200
  | 201
  | 202
  | 204
  | 400
  | 401
  | 403
  | 404
  | 409
  | 422
  | 429
  | 500
  | 502
  | 503;

type SecurityRequirement = Record<string, string[]>[];

type TypeBoxSchema = object;

interface BaseRouteSchema {
  description: string;
  tags: string[];
  body?: TypeBoxSchema;
  querystring?: TypeBoxSchema;
  params?: TypeBoxSchema;
  headers?: TypeBoxSchema;
  response: Partial<Record<HttpStatusCode, TypeBoxSchema>>;
  security?: SecurityRequirement;
  hide?: boolean;
  summary?: string;
  deprecated?: boolean;
}

export type { BaseRouteSchema };
