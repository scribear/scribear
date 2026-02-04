import { useState } from 'react';

import { TranscriptionDisplayContext } from './transcription-display-context';

interface TranscriptionDisplayProviderProps {
  children: React.ReactNode;
}

export const TranscriptionDisplayProvider = ({
  children,
}: TranscriptionDisplayProviderProps) => {
  const [containerHeightPx, setContainerHeightPx] = useState(0);

  return (
    <TranscriptionDisplayContext
      value={{ containerHeightPx, setContainerHeightPx }}
    >
      {children}
    </TranscriptionDisplayContext>
  );
};
