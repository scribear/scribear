import type { FaultParams, GoodParams } from '@scribear/test-audio-source';

/**
 * The two provisioned devices and the state one of them reports.
 *
 * This is the wire contract admin-server's `TestAudioDeviceState` restates
 * (PLAN-TestAudioDevices §2). The BFF passes our body through untouched, so a
 * field renamed here disappears from the operator's screen with nothing failing
 * in between — treat it as published.
 */

export type DeviceId = 'good' | 'fault';

/** Both ids, in the order the operator's page lays the cards out. */
export const DEVICE_IDS: readonly DeviceId[] = ['good', 'fault'];

/**
 * Where a device is in its run.
 *
 * `connecting` is the window between accepting a start and the first frame
 * reaching the wire — finding the room's active session, minting a session
 * token, opening and authenticating two WebSockets. It is reported separately
 * from `streaming` because that window is where every provisioning mistake
 * shows up (no session active, device in no room, token rejected), and an
 * operator watching a device sit in `connecting` is looking at a different
 * problem from one watching `streaming` with no transcripts.
 */
export type RunState = 'idle' | 'connecting' | 'streaming' | 'error';

export interface DeviceState {
  deviceId: DeviceId;
  /** A device token is configured for this device. */
  configured: boolean;
  state: RunState;
  params: GoodParams | FaultParams;
  sessionUid: string | null;
  /**
   * The room this device's token reaches, read from session-manager.
   *
   * Surfaced even while idle, and refreshed in the background, because the
   * device-to-room assignment is the entire safety boundary: an operator about
   * to point a synthetic source at a live pipeline should be able to read the
   * name of the room it will reach off the screen rather than recall a
   * provisioning script they ran once. Null when it has not been read yet, or
   * when the device is in no room at all.
   */
  roomName: string | null;
  startedAtMs: number | null;
  expiresAtMs: number | null;
  framesSent: number;
  /** Frames the fault engine altered. Always 0 for the `good` device. */
  framesFaulted: number;
  transcriptCount: number;
  lastTranscript: string | null;
  /** Why the last run ended badly, or null. Cleared by the next start. */
  error: string | null;
}
