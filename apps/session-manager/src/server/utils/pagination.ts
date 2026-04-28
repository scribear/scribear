interface CreatedAtCursor {
  type: 'createdAt';
  createdAt: string;
  uid: string;
}

interface SimilarityCursor {
  type: 'similarity';
  similarity: number;
  uid: string;
}

type Cursor = CreatedAtCursor | SimilarityCursor;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Encodes a `createdAt` timestamp and `uid` into an opaque base64url cursor string.
 * @param createdAt The row's creation timestamp.
 * @param uid The row's unique identifier, used as a tiebreaker when timestamps collide.
 */
export function encodeCreatedAtCursor(createdAt: Date, uid: string): string {
  return encode({ type: 'createdAt', createdAt: createdAt.toISOString(), uid });
}

/**
 * Encodes a trigram similarity score and `uid` into an opaque base64url cursor string.
 * Used for paginating fuzzy-search results ordered by similarity descending.
 * @param similarity The `word_similarity` score of the last row on the current page.
 * @param uid The row's unique identifier, used as a tiebreaker on equal scores.
 */
export function encodeSimilarityCursor(
  similarity: number,
  uid: string,
): string {
  return encode({ type: 'similarity', similarity, uid });
}

/**
 * Decodes a cursor string produced by {@link encodeCreatedAtCursor} or
 * {@link encodeSimilarityCursor}.
 * @param cursor The opaque cursor string from a previous response's `nextCursor` field.
 * @returns The decoded cursor, or `null` if the cursor is invalid or malformed.
 */
export function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj['type'] === 'createdAt') {
      if (
        typeof obj['createdAt'] !== 'string' ||
        typeof obj['uid'] !== 'string'
      )
        return null;
      return {
        type: 'createdAt',
        createdAt: obj['createdAt'],
        uid: obj['uid'],
      };
    }

    if (obj['type'] === 'similarity') {
      if (
        typeof obj['similarity'] !== 'number' ||
        typeof obj['uid'] !== 'string'
      )
        return null;
      return {
        type: 'similarity',
        similarity: obj['similarity'],
        uid: obj['uid'],
      };
    }

    return null;
  } catch {
    return null;
  }
}
