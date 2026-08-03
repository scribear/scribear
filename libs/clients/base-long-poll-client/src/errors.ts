import { UnexpectedResponseError } from '@scribear/base-api-client';

/**
 * A long-poll route answered with a status it *declares*, but which carries no
 * poll payload - anything other than 200 (new data) or 204 (no change).
 *
 * This exists because "declared" and "successful" are not the same thing, and
 * conflating them is actively dangerous here. `createEndpointClient` puts every
 * declared status in the *response* slot with a null error, on purpose: a 401
 * `INVALID_DEVICE_TOKEN` body is part of the contract, so callers get it typed
 * rather than as an opaque failure. The long-poll loop then only had to
 * distinguish 204 from "everything else", and treated a 401/404/500 body as if
 * it were the 200 payload - emitting `{ code, message }` on the `data` event.
 *
 * Downstream that was worse than a plain failure. node-server read
 * `transcriptionProviderId` off a 401 body, got `undefined`, and dialed
 * `.../transcription_stream/undefined`; the transcription service refused it and
 * the operator was shown `invalid-request` - sending them to hunt for a provider
 * misconfiguration that did not exist, when the real cause was a
 * `NODE_SERVER_KEY` mismatch. The kiosk read `sessions` off a 404
 * `DEVICE_NOT_IN_ROOM` body, got `undefined`, and threw inside the `data`
 * listener.
 *
 * A **subclass** of {@link UnexpectedResponseError} rather than a sibling, for
 * the same reason `InvalidResponseBodyError` is: both consumers already branch
 * on `instanceof UnexpectedResponseError` and read `.status`, and those branches
 * keep working unchanged and say something sane. Consumers that want to
 * distinguish "the service answered a contract error" from "the response was
 * off-contract entirely" test for this subclass and get {@link body} and
 * {@link code} with it.
 */
class LongPollResponseError extends UnexpectedResponseError {
  /** The declared, schema-validated response body for {@link status}. */
  readonly body: unknown;
  /**
   * The `code` field of the error body (`INVALID_DEVICE_TOKEN`,
   * `DEVICE_NOT_IN_ROOM`, `INTERNAL_ERROR`, ...) when the body carries one, or
   * `null`. This is the field that names the *cause*, so it is lifted out of
   * the body and into the message rather than left for each consumer to dig
   * for.
   */
  readonly code: string | null;

  /**
   * @param status Declared HTTP status that is neither 200 nor 204.
   * @param body Schema-validated response body for that status.
   */
  constructor(status: number, body: unknown) {
    const { code, detail } = describeBody(body);
    super(
      status,
      `Long-poll responded with status ${status.toString()}${
        code !== null ? ` (${code})` : ''
      }, which carries no poll payload.${detail !== null ? ` ${detail}` : ''}`,
    );
    this.name = 'LongPollResponseError';
    this.body = body;
    this.code = code;
  }
}

/**
 * Pull the canonical `{ code, message }` pair out of an error body, if it has
 * one. Every error body in the repo is `ErrorReply`-shaped, but nothing
 * guarantees a given route's is, so both fields are optional here.
 */
function describeBody(body: unknown): {
  code: string | null;
  detail: string | null;
} {
  if (typeof body !== 'object' || body === null) {
    return { code: null, detail: null };
  }
  const record = body as Record<string, unknown>;
  const code = record['code'];
  const message = record['message'];
  return {
    code: typeof code === 'string' ? code : null,
    detail: typeof message === 'string' ? message : null,
  };
}

export { LongPollResponseError };
