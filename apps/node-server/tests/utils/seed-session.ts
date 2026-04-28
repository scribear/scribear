import { createSessionManagerClient } from '@scribear/session-manager-client';
import type { Session } from '@scribear/session-manager-schema';

interface SeedSessionInput {
  /** Base URL of the running Session Manager (`http://...`). */
  sessionManagerBaseUrl: string;
  /** Admin API key the running Session Manager was configured with. */
  adminApiKey: string;
  /** Provider key configured on the running Transcription Service (`debug`). */
  transcriptionProviderId: string;
  /** Stream config to forward to the upstream provider. */
  transcriptionStreamConfig: unknown;
}

/**
 * Bootstraps the minimum Session Manager state needed to drive a Node Server
 * transcription-stream end-to-end test:
 *
 *   1. Register a placeholder source device.
 *   2. Create a room owned by that device.
 *   3. Create an on-demand session in that room with the supplied transcription
 *      provider + config.
 *
 * Returns the resulting `Session`, including its `uid` (use as the URL
 * sessionUid) and `sessionConfigVersion` (which must already be `>= 1` so the
 * Node Server orchestrator's long-poll resolves immediately with `sinceVersion=0`).
 */
export async function seedSession(input: SeedSessionInput): Promise<Session> {
  const sm = createSessionManagerClient(input.sessionManagerBaseUrl);
  const adminHeaders = { authorization: `Bearer ${input.adminApiKey}` };

  const deviceRes = await sm.deviceManagement.registerDevice({
    body: { name: 'integration-test-source-device' },
    headers: adminHeaders,
  });
  if (deviceRes[1] !== null) {
    throw new Error('registerDevice failed', { cause: deviceRes[1] });
  }
  if (deviceRes[0].status !== 201) {
    throw new Error(
      `registerDevice unexpected status: ${String(deviceRes[0].status)}`,
    );
  }
  const deviceUid = deviceRes[0].data.deviceUid;

  const roomRes = await sm.roomManagement.createRoom({
    body: {
      name: 'integration-test-room',
      timezone: 'America/New_York',
      autoSessionEnabled: false,
      sourceDeviceUids: [deviceUid],
    },
    headers: adminHeaders,
  });
  if (roomRes[1] !== null) {
    throw new Error('createRoom failed', { cause: roomRes[1] });
  }
  if (roomRes[0].status !== 201) {
    throw new Error(
      `createRoom unexpected status: ${String(roomRes[0].status)}`,
    );
  }
  const roomUid = roomRes[0].data.uid;

  const sessionRes = await sm.scheduleManagement.createOnDemandSession({
    body: {
      roomUid,
      name: 'integration-test-session',
      joinCodeScopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: input.transcriptionProviderId,
      transcriptionStreamConfig: input.transcriptionStreamConfig,
    },
    headers: adminHeaders,
  });
  if (sessionRes[1] !== null) {
    throw new Error('createOnDemandSession failed', { cause: sessionRes[1] });
  }
  if (sessionRes[0].status !== 201) {
    throw new Error(
      `createOnDemandSession unexpected status: ${String(sessionRes[0].status)}`,
    );
  }
  return sessionRes[0].data;
}
