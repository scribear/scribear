import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { FLEET_EVENT_SCHEMA } from '#src/index.js';

const SESSION_EVENT = {
  t: 'session',
  sessionUid: 'a4f1',
  transcriptionServiceConnected: true,
  sourceDeviceConnected: false,
  at: 1_731_970_000_123,
};

/** A copy of `value` with one field removed, to test a required field. */
function without<T extends object>(value: T, field: keyof T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== field),
  ) as Partial<T>;
}

describe('fleet event schema', () => {
  it('should accept a session status event', () => {
    // Assert
    expect(Value.Check(FLEET_EVENT_SCHEMA, SESSION_EVENT)).toBe(true);
  });

  it('should reject an event with no discriminator', () => {
    // Assert
    expect(Value.Check(FLEET_EVENT_SCHEMA, without(SESSION_EVENT, 't'))).toBe(
      false,
    );
  });

  it('should reject an unknown discriminator', () => {
    // Assert
    expect(
      Value.Check(FLEET_EVENT_SCHEMA, { ...SESSION_EVENT, t: 'node' }),
    ).toBe(false);
  });

  it('should reject a session event with no publish time', () => {
    // Without it a reader cannot order deltas against a snapshot's own
    // updatedAt, which is what "snapshot, then deltas" depends on.
    //
    // Assert
    expect(Value.Check(FLEET_EVENT_SCHEMA, without(SESSION_EVENT, 'at'))).toBe(
      false,
    );
  });
});
