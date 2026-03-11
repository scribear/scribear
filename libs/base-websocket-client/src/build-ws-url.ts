/**
 * Builds a WebSocket URL from a base URL and route template, substituting `:param`
 * tokens, appending query string fields, and converting http(s) to ws(s) protocol.
 *
 * @param baseUrl - Base URL of the server (http/https or ws/wss).
 * @param urlTemplate - Route URL with optional `:param` tokens.
 * @param params - URL path parameter values to substitute.
 * @param querystring - Query string key-value pairs to append.
 * @returns The fully constructed WebSocket URL string.
 */
export function buildWsUrl(
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

  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';

  return url.toString();
}
