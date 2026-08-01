import { describe, expect, it } from 'vitest';

import { SessionConnectionStatus } from '#src/features/session-provider/services/client-session-service-status';
import {
  clientSessionServiceReducer,
  setActiveSession,
  setSessionStatus,
} from '#src/features/session-provider/stores/client-session-service-slice';

describe('clientSessionServiceSlice', () => {
  it('seeds sessionStatus as null, not as an all-false snapshot', () => {
    const state = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );

    // Seeding {transcriptionServiceConnected: false, sourceDeviceConnected:
    // false} here made "node-server has not reported yet" indistinguishable
    // from "node-server reported a dead upstream", and put a fault banner on
    // screen from the instant of a *successful* join.
    expect(state.session).toEqual({
      sessionUid: 'session-uid',
      connectionStatus: SessionConnectionStatus.CONNECTING,
      sessionStatus: null,
    });
  });

  it('records the first reported sessionStatus', () => {
    const joined = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );
    const state = clientSessionServiceReducer(
      joined,
      setSessionStatus({
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
      }),
    );

    expect(state.session?.sessionStatus).toEqual({
      transcriptionServiceConnected: false,
      sourceDeviceConnected: false,
    });
  });

  it('clears the session on setActiveSession(null)', () => {
    const joined = clientSessionServiceReducer(
      undefined,
      setActiveSession('session-uid'),
    );
    expect(
      clientSessionServiceReducer(joined, setActiveSession(null)).session,
    ).toBeNull();
  });
});
