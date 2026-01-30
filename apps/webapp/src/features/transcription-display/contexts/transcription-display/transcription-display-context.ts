import { createContext, use } from 'react';

interface TranscriptionDisplayContextValue {
  containerHeightPx: number;
  setContainerHeightPx: (height: number) => void;
}

export const TranscriptionDisplayContext =
  createContext<TranscriptionDisplayContextValue | null>(null);

export const useTranscriptionDisplayHeight = () => {
  const context = use(TranscriptionDisplayContext);
  if (!context) {
    throw new Error(
      'useTranscriptionDisplayHeight must be used within a TranscriptionDisplayProvider',
    );
  }
  return context;
};
