import type { TSchema } from 'typebox';

/**
 * Defines a Redis pub/sub channel's message schema and key construction.
 *
 * @typeParam T - The TypeBox schema type for channel messages.
 * @typeParam TArgs - The argument types for the key builder function.
 */
export interface ChannelDefinition<
  T extends TSchema = TSchema,
  TArgs extends unknown[] = unknown[],
> {
  schema: T;
  key: (...args: TArgs) => string;
}
