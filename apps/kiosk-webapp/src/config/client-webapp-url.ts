// Keep the trailing slash so generated QR codes target the canonical
// client webapp path directly.
export const CLIENT_WEBAPP_URL =
  import.meta.env.VITE_CLIENT_WEBAPP_URL ?? `${window.location.origin}/client/`;

/**
 * The address to type when the QR cannot be scanned. Host only: nginx redirects
 * `/` to `/client/`, and a kiosk is read from across a room. `host`, not
 * `hostname`, so a dev deployment still shows its port.
 *
 * @returns e.g. `scribear.example.edu`, or the raw value if it does not parse.
 */
export function clientWebappDisplayUrl(): string {
  try {
    return new URL(CLIENT_WEBAPP_URL, window.location.origin).host;
  } catch {
    return CLIENT_WEBAPP_URL;
  }
}
