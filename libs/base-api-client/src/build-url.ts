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
export function buildUrl(
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
