import { createContext, use } from 'react';

import type { MicrophoneService } from '../services/microphone-service';

interface MicrophoneServiceContextValue {
  microphoneService: MicrophoneService;
}

export const MicrophoneServiceContext =
  createContext<MicrophoneServiceContextValue | null>(null);

export const useMicrophoneServiceContext = () => {
  const context = use(MicrophoneServiceContext);
  if (!context) {
    throw new Error(
      'useMicrophoneServiceContext must be used within a MicrophoneServiceProvider',
    );
  }
  return context;
};
