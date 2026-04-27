import { type TProperties, Type } from 'typebox';

/**
 * Cursor pagination querystring parameters shared by every Session Manager
 * list endpoint.
 */
export const PAGINATION_QUERY_SCHEMA = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 256 })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
    ),
  },
  { $id: 'PaginationQuery' },
);

/**
 * Extend the standard pagination querystring with endpoint-specific filter
 * fields. Returns a plain `Type.Object` so Fastify's schema validator sees
 * a flat shape (TypeBox intersections confuse Fastify's coercion layer).
 *
 * @param extras Additional querystring fields for the endpoint.
 * @returns A TypeBox object schema merging `extras` with `cursor` and `limit`.
 */
export function paginatedQuerySchema<T extends TProperties>(extras: T) {
  return Type.Object({
    ...extras,
    cursor: Type.Optional(Type.String({ maxLength: 256 })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
    ),
  });
}

/**
 * Standard list response envelope. `nextCursor` is `null` when the result is
 * exhausted.
 *
 * @param item Per-row TypeBox schema.
 * @returns A `{ items, nextCursor }` object schema parameterized on `item`.
 */
export const paginatedResponseSchema = <
  T extends ReturnType<typeof Type.Object>,
>(
  item: T,
) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  });
