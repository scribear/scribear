type HttpErrorCodes = 400 | 401 | 403 | 404 | 429 | 500;

/**
 * Base class of errors thrown for fastify error handler use
 * Message should be a user facing error message
 */
class BaseHttpError extends Error {
  statusCode: HttpErrorCodes = 500;
  code = 'HTTP_ERROR';
  override message =
    'Server encountered an unexpected error. Please try again later.';
}

/**
 * BadRequest error that contains list of error messages and validation error keys
 */
class HttpBadRequest extends BaseHttpError {
  override statusCode = 400 as const;
  override message = 'Bad Request';
  constructor(
    public requestErrors: {
      message: string;
      key: string;
    }[],
  ) {
    super();
    if (Error.stackTraceLimit !== 0) {
      Error.captureStackTrace(this, HttpBadRequest);
    }
  }
}

/**
 * Produces custom http error class derived from HttpError with statusCode set
 * @param statusCode http status code of error to create
 * @returns custom http error class
 */
function createHttpError(statusCode: HttpErrorCodes) {
  return class CustomHttpError extends BaseHttpError {
    constructor(message?: string) {
      super();
      if (message !== undefined) this.message = message;
      this.statusCode = statusCode;
      if (Error.stackTraceLimit !== 0) {
        Error.captureStackTrace(this, CustomHttpError);
      }
    }
  };
}

const HttpError = {
  BadRequest: HttpBadRequest,
  Unauthorized: createHttpError(401),
  Forbidden: createHttpError(403),
  NotFound: createHttpError(404),
  TooManyRequests: createHttpError(429),
  ServerError: createHttpError(500),
};

export { BaseHttpError, HttpError };
