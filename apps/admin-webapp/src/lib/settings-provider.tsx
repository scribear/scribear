import { useMemo, useState } from 'react';

import { type SettingsApi, SettingsContext } from './settings-context';

const SHOW_UUIDS_KEY = 'scribear-admin:show-uuids';

function readShowUuids(): boolean {
  try {
    return localStorage.getItem(SHOW_UUIDS_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persists app-wide display preferences (currently just "Show UUIDs") to
 * localStorage so the choice survives reloads across every admin page.
 */
export const SettingsProvider = ({ children }: React.PropsWithChildren) => {
  const [storedShowUuids, setStoredShowUuids] = useState(readShowUuids);

  const setShowUuids = (value: boolean) => {
    setStoredShowUuids(value);
    try {
      localStorage.setItem(SHOW_UUIDS_KEY, String(value));
    } catch {
      // Best-effort persistence; the toggle still works for this session.
    }
  };

  const api = useMemo<SettingsApi>(
    () => ({ showUuids: storedShowUuids, setShowUuids }),
    [storedShowUuids],
  );

  return <SettingsContext value={api}>{children}</SettingsContext>;
};
