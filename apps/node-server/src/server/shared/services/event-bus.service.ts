import type { Static, TSchema } from 'typebox';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Defines an event bus channel's message schema and key construction.
 *
 * @typeParam T - TypeBox schema for channel messages.
 * @typeParam TArgs - Argument types for the key builder.
 */
export interface ChannelDefinition<
  T extends TSchema = TSchema,
  TArgs extends unknown[] = unknown[],
> {
  schema: T;
  key: (...args: TArgs) => string;
}

/**
 * In-process publish/subscribe bus. Single-process by design: the audio
 * channel carries raw binary frames that should not be serialized, and
 * sticky-routed transcription-stream URLs guarantee every connection for a
 * given session lands on the same process anyway, so cross-process fanout is
 * not required.
 *
 * Listener exceptions are caught and logged so one bad subscriber cannot
 * starve the others. Publishers are fire-and-forget; there is no retry, no
 * persistence, and no delivery guarantee beyond "delivered to all currently
 * subscribed listeners on the local process".
 */
export class EventBusService {
  private _log: AppDependencies['logger'];
  private _channels = new Map<string, Set<(message: unknown) => void>>();

  constructor(logger: AppDependencies['logger']) {
    this._log = logger;
  }

  /**
   * Publish a message to the channel identified by `channelDef.key(...keyArgs)`.
   * Synchronously invokes every active subscriber on that key. No-op when no
   * subscribers are registered.
   */
  publish<T extends TSchema, TArgs extends unknown[]>(
    channelDef: ChannelDefinition<T, TArgs>,
    message: Static<T>,
    ...keyArgs: TArgs
  ): void {
    const key = channelDef.key(...keyArgs);
    const listeners = this._channels.get(key);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (err) {
        this._log.error({ err, key }, 'event-bus listener threw');
      }
    }
  }

  /**
   * Subscribe to messages on the channel identified by
   * `channelDef.key(...keyArgs)`. Returns an unsubscribe function; callers
   * must invoke it to free the listener (e.g. on socket close).
   */
  subscribe<T extends TSchema, TArgs extends unknown[]>(
    channelDef: ChannelDefinition<T, TArgs>,
    listener: (message: Static<T>) => void,
    ...keyArgs: TArgs
  ): () => void {
    const key = channelDef.key(...keyArgs);
    let set = this._channels.get(key);
    if (!set) {
      set = new Set();
      this._channels.set(key, set);
    }
    const cast = listener as (message: unknown) => void;
    set.add(cast);
    return () => {
      const s = this._channels.get(key);
      if (!s) return;
      s.delete(cast);
      if (s.size === 0) this._channels.delete(key);
    };
  }
}
