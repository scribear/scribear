import { Type } from 'typebox';

/**
 * Reply schema of shared API http error responses
 */
const SharedErrorReplySchema = {
  400: Type.Object(
    {
      requestErrors: Type.Array(
        Type.Object({
          message: Type.String(),
          key: Type.String({ default: '/body/some/nested/object/property' }),
        }),
      ),
      reqId: Type.String(),
    },
    {
      description:
        'Response when request was invalid. Each validation error has a user facing message about the error. Keys start with the part of request that had error ("/body", "/headers", "/params", "/querystring").',
    },
  ),
  401: Type.Object(
    {
      message: Type.String(),
      reqId: Type.String(),
    },
    {
      description:
        'Response when request failed authentication. Message will contain user facing reason why.',
    },
  ),
  403: Type.Object(
    {
      message: Type.String(),
      reqId: Type.String(),
    },
    {
      description:
        'Response when request failed authorization. Message will contain user facing reason why.',
    },
  ),
  404: Type.Object(
    {
      message: Type.String(),
      reqId: Type.String(),
    },
    {
      description: 'Response when request had no matching path on server.',
    },
  ),
  429: Type.Object(
    {
      message: Type.String(),
      reqId: Type.String(),
    },
    {
      description: 'Response when request is rate limited.',
    },
  ),
  500: Type.Object(
    {
      message: Type.String(),
      reqId: Type.String(),
    },
    {
      description: 'Response when server encounters an unexpected error.',
    },
  ),
};

export { SharedErrorReplySchema };
