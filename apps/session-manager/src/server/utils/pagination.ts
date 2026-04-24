interface Cursor {
  createdAt: string;
  uid: string;
}

/**
 * Encodes a `createdAt` timestamp and `uid` into an opaque base64url cursor string.
 * @param createdAt The row's creation timestamp.
 * @param uid The row's unique identifier, used as a tiebreaker when timestamps collide.
 * @returns An opaque base64url-encoded cursor string.
 */
export function encodeCursor(createdAt: Date, uid: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), uid }),
  ).toString('base64url');
}

/**
 * Decodes a cursor string produced by {@link encodeCursor}.
 * @param cursor The opaque cursor string from a previous response's `nextCursor` field.
 * @returns The decoded `{ createdAt, uid }` pair, or `null` if the cursor is invalid or malformed.
 */
export function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { createdAt, uid } = parsed as Record<string, unknown>;
    if (typeof createdAt !== 'string' || typeof uid !== 'string') return null;
    return { createdAt, uid };
  } catch {
    return null;
  }
}
