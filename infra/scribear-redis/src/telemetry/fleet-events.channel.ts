import type { ChannelDefinition } from '../pubsub/types.js';
import { FLEET_EVENT_SCHEMA } from './fleet-event.schema.js';
import { FLEET_EVENTS_CHANNEL_KEY } from './telemetry-keys.js';

/**
 * The one channel of the fleet event backplane. Fixed key, no arguments -
 * unlike the snapshot keys, deltas are not scoped to one session or instance,
 * so there is nothing to key on.
 */
export const FleetEventsChannel: ChannelDefinition<
  typeof FLEET_EVENT_SCHEMA,
  []
> = {
  schema: FLEET_EVENT_SCHEMA,
  key: () => FLEET_EVENTS_CHANNEL_KEY,
};
