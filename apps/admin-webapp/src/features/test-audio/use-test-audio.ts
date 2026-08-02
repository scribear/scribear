import { useEffect, useState } from 'react';

import type {
  StartTestAudioBody,
  TestAudioDeviceId,
  TestAudioDeviceState,
  TestAudioParamsPatch,
} from '#src/lib/admin-api';
import { adminApi } from '#src/lib/admin-api';
import { useToast } from '#src/lib/toast-context';
import { useAsyncData } from '#src/lib/use-async-data';

/**
 * How often the page re-reads `GET /test-audio` (§4).
 *
 * 3 s, and no SSE: this is a two-row table whose counters are the whole reason
 * the page is open. Anything slower and "turn a knob, watch the meter move" —
 * the feature's entire purpose — stops feeling connected to the knob.
 */
export const TEST_AUDIO_POLL_MS = 3_000;

/**
 * Whether a device is on the audio path right now.
 *
 * `connecting` counts: the device has already claimed the room's session and a
 * parameter change from here must retune rather than restart (§2). Treating it
 * as idle would send a `start` to a device that is mid-start.
 */
export function isRunning(device: TestAudioDeviceState): boolean {
  return device.state === 'connecting' || device.state === 'streaming';
}

export interface TestAudioState {
  /** False when the deployment never provisioned the devices. Null until the
   *  first read settles, so the page can tell "not configured" apart from
   *  "not known yet" — rendering the disabled explanation during the first
   *  round trip would flash a misconfiguration at a working deployment. */
  available: boolean | null;
  devices: TestAudioDeviceState[];
  /** True only while the *first* read is in flight; a poll that refreshes an
   *  already-rendered page must not put a spinner over it. */
  loading: boolean;
  error: unknown;
  /** Re-read now, e.g. straight after a mutation. */
  refresh: () => void;
}

/**
 * Polls the test-audio device list while the page is visible.
 *
 * The `health-indicator.tsx` / `use-fleet.ts` shape: an interval gated on
 * `!document.hidden`, plus an immediate read on becoming visible again (a
 * hidden tab skips its ticks, so without that the operator comes back to
 * numbers up to a full interval stale — which looks live and isn't), and both
 * the timer and the listener torn down on unmount.
 *
 * Unlike `useFleet`, the poll is *not* gated on `available`: an unconfigured
 * deployment is a cheap, correct `{ available: false, devices: [] }` response
 * rather than a thrown error, and an operator who sets `TEST_AUDIO_BASE_URL`
 * and restarts admin-server should see the panel come alive without a reload.
 */
export function useTestAudio(): TestAudioState {
  const { data, loading, error, reload } = useAsyncData(
    () => adminApi.testAudio(),
    [],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) reload();
    }, TEST_AUDIO_POLL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [reload]);

  return {
    available: data === null ? null : data.available,
    devices: data?.devices ?? [],
    loading: loading && data === null,
    error,
    refresh: reload,
  };
}

export interface DeviceRunControls {
  /** A start or stop request is in flight. Retunes are deliberately excluded:
   *  they are debounced, frequent, and must never disable the control that
   *  issued them. */
  busy: boolean;
  start: (params: StartTestAudioBody['params'], durationSec: number) => void;
  stop: () => void;
  /** Live retune of a running device. Sends only the knobs that moved. */
  retune: (patch: TestAudioParamsPatch) => void;
}

/**
 * The three mutations for one device, with their toasts and their in-flight
 * flag. Deliberately knows nothing about the shape of `params` — the two
 * devices' parameter types have nothing in common, so the cards own their own
 * typed state and hand a plain body through here.
 */
export function useDeviceRun(
  deviceId: TestAudioDeviceId,
  refresh: () => void,
): DeviceRunControls {
  const { showSuccess, showApiError } = useToast();
  const [busy, setBusy] = useState(false);

  const run = (
    request: Promise<TestAudioDeviceState>,
    success: string,
    failure: string,
  ) => {
    setBusy(true);
    request
      .then(() => {
        showSuccess(success);
      })
      .catch((err: unknown) => {
        showApiError(err, failure);
      })
      .finally(() => {
        setBusy(false);
        // Whether it worked or not, the authoritative state is the device's.
        refresh();
      });
  };

  return {
    busy,
    start: (params, durationSec) => {
      run(
        adminApi.startTestAudio(deviceId, { params, durationSec }),
        `Started the ${deviceId} source.`,
        `Failed to start the ${deviceId} source.`,
      );
    },
    stop: () => {
      run(
        adminApi.stopTestAudio(deviceId),
        `Stopped the ${deviceId} source.`,
        `Failed to stop the ${deviceId} source.`,
      );
    },
    retune: (patch) => {
      // No success toast and no busy flag: a retune happens every time a
      // slider settles, and a toast per knob would bury the page. A failure
      // still needs saying — silently ignoring it would leave the operator
      // watching a meter for an effect that was never applied.
      adminApi.updateTestAudioParams(deviceId, patch).catch((err: unknown) => {
        showApiError(err, `Failed to retune the ${deviceId} source.`);
      });
    },
  };
}
