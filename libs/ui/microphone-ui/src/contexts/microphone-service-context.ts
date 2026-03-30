import { createContext, use } from 'react';

import type { MicrophoneService } from '@scribear/microphone-store';

/**
 * The singleton `MicrophoneService` instance exposed through context.
 */
export interface MicrophoneServiceContextValue {
  microphoneService: MicrophoneService;
}

// React context object for the microphone service singleton. Populated by `MicrophoneServiceProvider`.
export const MicrophoneServiceContext =
  createContext<MicrophoneServiceContextValue | null>(null);

/**
 * Reads `MicrophoneServiceContext`. Throws if used outside a provider.
 */
export const useMicrophoneServiceContext = () => {
  const context = use(MicrophoneServiceContext);
  if (!context) {
    throw new Error(
      'useMicrophoneServiceContext must be used within a MicrophoneServiceContext provider',
    );
  }
  return context;
};
