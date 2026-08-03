/**
 * Builds a client-webapp deep link that auto-joins a session. The client
 * webapp reads a base64 `#config=` fragment and pre-fills/exchanges the join
 * code — the same format the kiosk QR uses. The link is same-origin: the admin
 * console and the client webapp are both served behind the one reverse proxy,
 * so a root-relative origin is correct in every environment.
 *
 * The trailing slash matters: nginx serves the client webapp at `/client/`, and
 * `/client` (no slash) 404s.
 */
export function buildJoinUrl(joinCode: string): string {
  const config = { clientSessionConfig: { joinCode } };
  const encoded = btoa(JSON.stringify(config));
  return `${window.location.origin}/client/#config=${encoded}`;
}
