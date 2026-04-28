/**
 * Close codes that every WebSocket route receives regardless of its
 * application-level logic. Spread into a route's `closeCodes` map; routes
 * add their own 4xxx application codes alongside.
 *
 * Pseudo-codes (1005, 1006, 1015) are included because the browser surfaces
 * them in close events even though no endpoint ever sends them in a close
 * frame. Omitting them would cause the client to emit spurious schema errors
 * on routine network drops.
 */
export const STANDARD_WS_CLOSE_CODES = {
  /** Clean, intentional close. Both sides agreed the session is done. */
  1000: { description: 'Normal closure.' },
  /** Server is shutting down or the client is navigating away. */
  1001: { description: 'Going away.' },
  /**
   * The close frame arrived without a status code. Never sent explicitly by
   * an endpoint; surfaced by the runtime when the peer omits the code field.
   */
  1005: { description: 'No status code received.' },
  /**
   * The connection was dropped without a close frame (e.g. network loss).
   * Never sent explicitly by an endpoint.
   */
  1006: { description: 'Abnormal closure.' },
  /** The server encountered an unexpected condition. */
  1011: { description: 'Internal server error.' },
  /** The server is restarting; the client should reconnect. */
  1012: { description: 'Service restart.' },
  /** The server is temporarily unable to handle this connection. */
  1013: { description: 'Try again later.' },
  /**
   * TLS handshake failed. Never sent explicitly by an endpoint; surfaced by
   * the TLS layer.
   */
  1015: { description: 'TLS handshake failure.' },
} as const;
