import { type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { buildUrl } from './build-url.js';
import {
  InvalidResponseBodyError,
  NetworkError,
  UnexpectedResponseError,
} from './errors.js';

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

/**
 * Every error the client can put in the error slot. {@link
 * InvalidResponseBodyError} is deliberately absent because it extends
 * {@link UnexpectedResponseError} and is therefore already covered - callers
 * narrowing on the union keep working, and callers that care can test for the
 * subclass.
 */
type EndpointError = NetworkError | UnexpectedResponseError;

/**
 * Two-slot result tuple. A declared status with a valid body returns as a
 * typed response regardless of whether the status is 2xx or 4xx. Any other
 * outcome (network failure, undeclared status, unparseable body, body schema
 * mismatch) populates the error slot.
 *
 * The client never rejects: every failure mode lands in the error slot.
 */
type EndpointResult<S extends BaseRouteSchema> =
  | [response: EndpointResponse<S>, error: null]
  | [response: null, error: EndpointError];

/**
 * Creates a typed fetch function for a specific API endpoint.
 *
 * Contract:
 *
 * - Declared statuses with matching bodies -> typed response.
 * - Fetch rejects -> {@link NetworkError}.
 * - Any other status, or a body failing the declared schema -> {@link UnexpectedResponseError}.
 * - A declared status whose body is not readable JSON at all ->
 *   {@link InvalidResponseBodyError}, a subclass of
 *   {@link UnexpectedResponseError}.
 *
 * Infrastructure statuses (502, 503, 504) fall into `UnexpectedResponseError`
 * because routes don't declare them; callers branch on `error.status` when
 * they need to. 429 is *not* in that list: session-manager's rate-limited
 * routes declare it and return a canonical `ErrorReply` body, so it arrives
 * as a typed response. Routes that opt into a rate limiter without declaring
 * 429 are the exception, not the rule.
 *
 * Note this function returns only `{status, data}` — response *headers* are
 * discarded, so `Retry-After` on a 429 is not reachable from here.
 *
 * The returned function never rejects. Every failure - including a body that
 * cannot be parsed - is reported through the error slot of the tuple.
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

    // A declared status is no guarantee the service produced the body: a
    // proxy can serve an HTML 500, a 400 can arrive empty, and a dropped
    // connection leaves truncated JSON. Parsing must not escape the tuple.
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause: unknown) {
      return [null, new InvalidResponseBodyError(status, cause)];
    }

    if (!Value.Check(responseSchema, body)) {
      return [null, new UnexpectedResponseError(status)];
    }

    return [{ status, data: body } as EndpointResponse<S>, null];
  };
}

export { createEndpointClient };
export type { EndpointParams, EndpointResponse, EndpointResult, EndpointError };
