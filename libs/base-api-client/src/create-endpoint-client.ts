import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { NetworkError, SchemaValidationError } from './errors.js';

type InputKey = 'body' | 'querystring' | 'params' | 'headers';

/**
 * Extracts a typed params object from a route schema, including only the keys
 * (body, querystring, params, headers) that are defined in the schema.
 */
type EndpointParams<S extends BaseRouteSchema> = {
  [K in InputKey as undefined extends S[K] ? never : K]: S[K] extends TSchema
    ? Static<S[K]>
    : never;
};

/**
 * A discriminated union of all response types defined in the schema, keyed by HTTP status code.
 */
type EndpointResponse<S extends BaseRouteSchema> = {
  [K in keyof S['response'] & number]: {
    status: K;
    data: S['response'][K] extends TSchema ? Static<S['response'][K]> : never;
  };
}[keyof S['response'] & number];

/**
 * Result tuple returned by an endpoint client function.
 * Either a typed response or an error — never both.
 */
type EndpointResult<S extends BaseRouteSchema> =
  | [response: EndpointResponse<S>, error: null]
  | [response: null, error: NetworkError | SchemaValidationError];

/**
 * Builds a URL from a base URL and route template, substituting `:param` tokens and
 * appending query string fields.
 *
 * @param baseUrl - Base URL of the API server.
 * @param urlTemplate - Route URL with optional `:param` tokens.
 * @param params - URL path parameter values to substitute.
 * @param querystring - Query string key-value pairs to append.
 * @returns The fully constructed URL string.
 */
function buildUrl(
  baseUrl: string,
  urlTemplate: string,
  params: Record<string, string> | undefined,
  querystring: Record<string, string> | undefined,
): string {
  let path = urlTemplate;

  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  const url = new URL(path, baseUrl);

  if (querystring !== undefined) {
    for (const [key, value] of Object.entries(querystring)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

/**
 * Creates a typed fetch function for a specific API endpoint.
 *
 * The returned function validates all responses (any status code) against the TypeBox
 * schema defined for that status in the route schema. Both success and error HTTP
 * responses are returned in the result slot of the tuple if they match their schema.
 *
 * @param schema - The BaseRouteSchema for this endpoint (use `satisfies BaseRouteSchema`).
 * @param route - The BaseRouteDefinition specifying the HTTP method and URL pattern.
 * @param baseUrl - Base URL of the API server (e.g. 'http://localhost:3000').
 * @returns A typed async function that fetches the endpoint and validates the response.
 */
function createEndpointClient<S extends BaseRouteSchema>(
  schema: S,
  route: BaseRouteDefinition,
  baseUrl: string,
): (
  params: EndpointParams<S>,
  init?: RequestInit,
) => Promise<EndpointResult<S>> {
  return async function (
    params: EndpointParams<S>,
    init?: RequestInit,
  ): Promise<EndpointResult<S>> {
    const typedParams = params as {
      body?: Record<string, unknown>;
      querystring?: Record<string, string>;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    };

    const url = buildUrl(
      baseUrl,
      route.url,
      typedParams.params,
      typedParams.querystring,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        method: route.method,
        headers: {
          ...(typedParams.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(init?.headers as Record<string, string> | undefined),
          ...(typedParams.headers ?? {}),
        },
        ...(typedParams.body !== undefined
          ? { body: JSON.stringify(typedParams.body) }
          : {}),
      });
    } catch (cause: unknown) {
      return [null, new NetworkError(cause)];
    }

    const status = response.status;
    const responseSchema = (
      schema.response as Record<number, TSchema | undefined>
    )[status];

    if (responseSchema === undefined) {
      return [null, new SchemaValidationError(status)];
    }

    // 204 No Content has no body to parse.
    if (status === 204) {
      return [{ status, data: null } as unknown as EndpointResponse<S>, null];
    }

    const body: unknown = await response.json();

    if (!Value.Check(responseSchema, body)) {
      return [null, new SchemaValidationError(status)];
    }

    return [{ status, data: body } as EndpointResponse<S>, null];
  };
}

export { createEndpointClient };
export type { EndpointParams, EndpointResponse, EndpointResult };
