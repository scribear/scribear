/**
 * Session token security identifier. Devices obtain a session token from
 * Session Manager (`exchange-device-token` / `exchange-join-code` /
 * `refresh-session-token`) and present it on the WebSocket handshake by
 * sending an `auth` client message after the connection opens.
 *
 * Carrying the token in a post-open message keeps it out of URLs, query
 * strings, and proxy access logs.
 */
export const SESSION_TOKEN_SECURITY = [{ sessionToken: [] }];
