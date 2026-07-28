import { describe, expect, it } from 'vitest';

import { TranscriptionServiceDisconnectReason } from '@scribear/node-server-schema';

import type { SessionStatusSnapshot } from '#src/features/session-provider/services/client-session-service';
import { SessionConnectionStatus } from '#src/features/session-provider/services/client-session-service-status';
import { deriveConnectionBanner } from '#src/features/session-provider/stores/derive-connection-banner';

const CONNECTED_SNAPSHOT: SessionStatusSnapshot = {
  transcriptionServiceConnected: true,
  sourceDeviceConnected: true,
};

describe('deriveConnectionBanner', () => {
  it('reports the client socket as reconnecting when CONNECTING, regardless of sessionStatus', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTING, null),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });

  it('reports the client socket as reconnecting when DISCONNECTED, even if sessionStatus looks fine', () => {
    expect(
      deriveConnectionBanner(
        SessionConnectionStatus.DISCONNECTED,
        CONNECTED_SNAPSHOT,
      ),
    ).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });

  it('does not report the nested transcription-service state when the own socket is down', () => {
    // Even though the transcription service is also down (and at capacity),
    // the own-socket message should win - it explains everything else.
    const result = deriveConnectionBanner(SessionConnectionStatus.CONNECTING, {
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });
    expect(result).toEqual({
      open: true,
      severity: 'warning',
      message: 'Connection lost. Reconnecting…',
    });
  });

  it('reports the at-capacity message when connected but the transcription service refused for capacity', () => {
    const result = deriveConnectionBanner(SessionConnectionStatus.CONNECTED, {
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
      transcriptionServiceDisconnectReason:
        TranscriptionServiceDisconnectReason.AT_CAPACITY,
    });
    expect(result).toEqual({
      open: true,
      severity: 'warning',
      message:
        'The live transcription service is at capacity. Retrying automatically…',
    });
  });

  it('reports a generic message when connected but the transcription service is down for an unknown reason', () => {
    const result = deriveConnectionBanner(SessionConnectionStatus.CONNECTED, {
      transcriptionServiceConnected: false,
      sourceDeviceConnected: true,
    });
    expect(result).toEqual({
      open: true,
      severity: 'warning',
      message:
        'Connection to the transcription service was lost. Reconnecting…',
    });
  });

  it('closes the banner when connected and the transcription service is connected', () => {
    expect(
      deriveConnectionBanner(
        SessionConnectionStatus.CONNECTED,
        CONNECTED_SNAPSHOT,
      ),
    ).toEqual({ open: false });
  });

  it('closes the banner when connected and there is no sessionStatus yet', () => {
    expect(
      deriveConnectionBanner(SessionConnectionStatus.CONNECTED, null),
    ).toEqual({ open: false });
  });
});
