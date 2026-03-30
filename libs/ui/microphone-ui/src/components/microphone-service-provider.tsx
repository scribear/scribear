import { type MicrophoneService } from '@scribear/microphone-store';

import { MicrophoneServiceContext } from '#src/contexts/microphone-service-context.js';

/**
 * Props for {@link MicrophoneServiceProvider}.
 */
interface MicrophoneServiceProviderProps {
  // The microphone service instance to provide via context.
  service: MicrophoneService;
  // Child components that will have access to the microphone service context.
  children: React.ReactNode;
}

/**
 * Provides a `MicrophoneService` instance via `MicrophoneServiceContext`.
 */
export const MicrophoneServiceProvider = ({
  service,
  children,
}: MicrophoneServiceProviderProps) => {
  return (
    <MicrophoneServiceContext value={{ microphoneService: service }}>
      {children}
    </MicrophoneServiceContext>
  );
};
