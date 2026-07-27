/**
 * The kiosk is served from the same origin as this admin console — one
 * reverse proxy in front of both apps — so the page's own location (protocol,
 * hostname, port) is the only correct source for the link. A hardcoded scheme
 * or port would be wrong the moment the console is reached differently (plain
 * HTTP on a local deployment, a non-default port), and reading one from
 * config would just be a second, potentially stale, copy of the same fact the
 * browser already knows by construction.
 */
export function kioskUrl(): string {
  return `${window.location.origin}/kiosk`;
}
