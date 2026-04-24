import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { buildUrl } from './build-url.js';
import { NetworkError, UnexpectedResponseError } from './errors.js';

type InputKey = 'body' | 'querystring' | 'params' | 'headers';

/**
 * Typed bag of request inputs required by the route. Keys are present only
 * when the corresponding schema field is declared.
 */
type EndpointParams<S extends BaseRouteSchema> = {
  [K in InputKey as undefined extends S[K] ? never : K]: S[K] extends TSchema
    ? Static<S[K]>
    : never;
};

/**
 * Discriminated union of all declared responses, keyed by HTTP status code.
 */
type EndpointResponse<S extends BaseRouteSchema> = {
  [K in keyof S['response'] & number]: {
    status: K;
    data: S['response'][K] extends TSchema ? Static<S['response'][K]> : never;
  };
}[keyof S['response'] & number];

type EndpointError = NetworkError | UnexpectedResponseError;

/**
 * Two-slot result tuple. A declared status with a valid body returns as a
 * typed response regardless of whether the status is 2xx or 4xx. Any other
 * outcome (network failure, undeclared status, body schema mismatch)
 * populates the error slot.
 */
type EndpointResult<S extends BaseRouteSchema> =
  | [response: EndpointResponse<S>, error: null]
  | [response: null, error: EndpointError];

/**
 * Creates a typed fetch function for a specific API endpoint.
 *
 * Contract:
 *
 * - Declared statuses with matching bodies → typed response.
 * - Fetch rejects → {@link NetworkError}.
 * - Any other status, or a body failing the declared schema → {@link UnexpectedResponseError}.
 *
 * Infrastructure statuses (429, 502, 503, 504) fall into
 * `UnexpectedResponseError` because routes don't declare them; callers
 * branch on `error.status` when they need to.
 *
 * @param schema BaseRouteSchema for this endpoint.
 * @param route HTTP method + URL pattern.
 * @param baseUrl Base URL of the API server.
 * @returns A typed async function that fetches and validates the endpoint.
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
      return [null, new UnexpectedResponseError(status)];
    }

    // 204 No Content has no body to parse.
    if (status === 204) {
      return [{ status, data: null } as EndpointResponse<S>, null];
    }

    const body: unknown = await response.json();
    if (!Value.Check(responseSchema, body)) {
      return [null, new UnexpectedResponseError(status)];
    }

    return [{ status, data: body } as EndpointResponse<S>, null];
  };
}

export { createEndpointClient };
export type { EndpointParams, EndpointResponse, EndpointResult, EndpointError };
