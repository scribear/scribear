import { type Static, Type } from 'typebox';

/**
 * A device as returned by admin-scoped endpoints. The `roomUid` / `isSource`
 * fields are populated when the device is a member of a room; `null` otherwise.
 */
export const DEVICE_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    active: Type.Boolean(),
    roomUid: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    isSource: Type.Union([Type.Boolean(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    /**
     * When the device last made an authenticated request. Null means it has
     * not been heard from since presence tracking shipped (B1.6) — not that it
     * was never registered.
     */
    lastSeenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    /**
     * Whether `lastSeenAt` is within the online TTL. Derived server-side so
     * every consumer agrees on the cutoff rather than each picking its own.
     */
    online: Type.Boolean(),
  },
  { $id: 'Device' },
);

export type Device = Static<typeof DEVICE_SCHEMA>;

/**
 * The subset of device fields visible to the device itself via `DEVICE_TOKEN`
 * authentication. Fields like `active` or `hash` are omitted.
 */
export const SELF_DEVICE_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    roomUid: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    isSource: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { $id: 'SelfDevice' },
);

export type SelfDevice = Static<typeof SELF_DEVICE_SCHEMA>;
