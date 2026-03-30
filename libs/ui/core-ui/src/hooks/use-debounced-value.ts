import { useEffect, useState } from 'react';

import { DEFAULT_DEBOUNCE_DELAY } from '#src/config/constants.js';

import { useDebouncedCallback } from './use-debounced-callback.js';

/**
 * Bridges an upstream controlled value with a locally responsive copy.
 *
 * The returned `localValue` updates immediately whenever the upstream `value`
 * changes. Calling `handleChange` updates `localValue` right away but only
 * propagates the new value to `setter` after `delayMs` milliseconds of
 * inactivity, preventing excessive upstream updates (e.g. Redux dispatches)
 * while the user is still interacting.
 *
 * @param value The upstream value to mirror locally.
 * @param setter The upstream setter called after the debounce delay elapses.
 * @param delayMs Debounce delay in milliseconds. Defaults to `DEFAULT_DEBOUNCE_DELAY`.
 * @returns A tuple of `[localValue, handleChange]`.
 */
export const useDebouncedValue = <T>(
  value: T,
  setter: (v: T) => void,
  delayMs: number = DEFAULT_DEBOUNCE_DELAY,
): [T, (v: T) => void] => {
  const [localValue, setLocalValue] = useState<T>(value);

  useEffect(() => {
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect -- intentional sync of upstream value into local state
    setLocalValue(value);
  }, [value]);

  const debouncedSetter = useDebouncedCallback((v: T) => {
    setter(v);
  }, delayMs);

  const handleChange = (newValue: T) => {
    setLocalValue(newValue);
    debouncedSetter(newValue);
  };

  return [localValue, handleChange];
};
