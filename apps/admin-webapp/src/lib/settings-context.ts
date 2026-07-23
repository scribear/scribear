import { createContext, use } from 'react';

export interface SettingsApi {
  showUuids: boolean;
  setShowUuids: (value: boolean) => void;
}

export const SettingsContext = createContext<SettingsApi | null>(null);

export function useSettings(): SettingsApi {
  const ctx = use(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider.');
  }
  return ctx;
}
