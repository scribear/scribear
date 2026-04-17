import { useEffect, useState } from 'react';

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
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  useEffect(() => {
    if (!isMicActive) {
      setAnalyserNode(null);
      return;
    }

    const tap = microphoneService.createAnalyserTap();
    setAnalyserNode(tap.analyserNode);

    return () => {
      microphoneService.closeAnalyserTap(tap);
      setAnalyserNode(null);
    };
  }, [isMicActive, microphoneService]);

  return analyserNode;
}
