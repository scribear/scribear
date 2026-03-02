import type { TSchema } from "typebox";

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

interface BaseRouteSchema {
  description: string;
  tags: string[];
  body?: TSchema;
  querystring?: TSchema;
  params?: TSchema;
  headers?: TSchema;
  response: Partial<Record<HttpStatusCode, TSchema>>;
  security?: SecurityRequirement;
  hide?: boolean;
  summary?: string;
  deprecated?: boolean;
}

export type { BaseRouteSchema };
