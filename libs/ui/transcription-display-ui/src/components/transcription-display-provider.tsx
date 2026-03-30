import { useState } from 'react';

import { TranscriptionDisplayHeightContext } from '#src/contexts/transcription-display-height-context.js';

/**
 * Props for {@link TranscriptionDisplayProvider}.
 */
interface TranscriptionDisplayProviderProps {
  // The React subtree that will have access to container height state via context.
  children: React.ReactNode;
}

/**
 * Provides container height state to child transcription display components.
 * Must wrap `TranscriptionDisplayContainer` and any preference controls that
 * depend on container height.
 */
export const TranscriptionDisplayProvider = ({
  children,
}: TranscriptionDisplayProviderProps) => {
  const [containerHeightPx, setContainerHeightPx] = useState(0);

  return (
    <TranscriptionDisplayHeightContext
      value={{ containerHeightPx, setContainerHeightPx }}
    >
      {children}
    </TranscriptionDisplayHeightContext>
  );
};
