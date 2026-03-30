import { createContext, use } from 'react';

/**
 * Shared container height state used to compute bounded display preferences.
 */
interface TranscriptionDisplayHeightContextValue {
  containerHeightPx: number;
  setContainerHeightPx: (height: number) => void;
}

// React context object for the transcription display container height. Populated by `TranscriptionDisplayProvider`.
export const TranscriptionDisplayHeightContext =
  createContext<TranscriptionDisplayHeightContextValue | null>(null);

/**
 * Reads `TranscriptionDisplayHeightContext`. Throws if used outside a `TranscriptionDisplayProvider`.
 */
export const useTranscriptionDisplayHeight = () => {
  const context = use(TranscriptionDisplayHeightContext);
  if (!context) {
    throw new Error(
      'useTranscriptionDisplayHeight must be used within a TranscriptionDisplayProvider',
    );
  }
  return context;
};
