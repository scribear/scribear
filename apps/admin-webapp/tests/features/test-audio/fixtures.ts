import {
  DEFAULT_FAULT_PARAMS,
  DEFAULT_GOOD_PARAMS,
} from '#src/features/test-audio/params-meta';
import type {
  TestAudioFaultDevice,
  TestAudioGoodDevice,
  TestAudioStatus,
} from '#src/lib/admin-api';

/** Everything the two devices report identically. */
const BASE = {
  configured: true,
  state: 'idle',
  sessionUid: null,
  roomName: 'TEST-AUDIO',
  startedAtMs: null,
  expiresAtMs: null,
  framesSent: 0,
  framesFaulted: 0,
  transcriptCount: 0,
  lastTranscript: null,
  error: null,
} as const;

/**
 * The `good` device, device 1 of two.
 *
 * `DeviceState` is discriminated on `deviceId` — the field decides the shape of
 * `params` — so one builder cannot serve both without handing every caller back
 * a union to narrow. Two builders, and this one keeps the plain name because
 * `good` is the device an operator reaches for first.
 */
export function buildDeviceState(
  overrides: Partial<TestAudioGoodDevice> = {},
): TestAudioGoodDevice {
  return {
    ...BASE,
    deviceId: 'good',
    params: { ...DEFAULT_GOOD_PARAMS },
    ...overrides,
  };
}

/** The `fault` device, device 2 of two. */
export function buildFaultDeviceState(
  overrides: Partial<TestAudioFaultDevice> = {},
): TestAudioFaultDevice {
  return {
    ...BASE,
    deviceId: 'fault',
    params: { ...DEFAULT_FAULT_PARAMS },
    ...overrides,
  };
}

/** A configured deployment reporting both devices. */
export function buildStatus(
  overrides: Partial<TestAudioStatus> = {},
): TestAudioStatus {
  return {
    available: true,
    devices: [buildDeviceState(), buildFaultDeviceState()],
    ...overrides,
  };
}
