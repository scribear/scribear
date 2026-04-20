import { useCallback, useRef, useSyncExternalStore } from 'react';

import { selectIsMicrophoneServiceActive } from '@scribear/microphone-store';
import { useMicrophoneServiceContext } from '@scribear/microphone-ui';

import { useAppSelector } from '#src/store/use-redux';

/**
 * Manages the lifecycle of an {@link AnalyserNode} tied to the active microphone
 * stream. Returns null when the microphone is not active.
 */
export function useVisualizerAnalyser(): AnalyserNode | null {
  const { microphoneService } = useMicrophoneServiceContext();
  const isMicActive = useAppSelector(selectIsMicrophoneServiceActive);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const tap = isMicActive ? microphoneService.createAnalyserTap() : null;
      analyserRef.current = tap?.analyserNode ?? null;
      onStoreChange();

      return () => {
        if (tap) microphoneService.closeAnalyserTap(tap);
        analyserRef.current = null;
        onStoreChange();
      };
    },
    [isMicActive, microphoneService],
  );

  return useSyncExternalStore(subscribe, () => analyserRef.current);
}
