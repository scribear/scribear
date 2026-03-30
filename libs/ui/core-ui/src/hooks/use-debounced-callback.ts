import { useCallback, useEffect, useRef } from 'react';

import { DEFAULT_DEBOUNCE_DELAY } from '#src/config/constants.js';

/**
 * Returns a stable, debounced version of `fn`.
 *
 * Each call to the returned function restarts a `delayMs`-millisecond timer;
 * `fn` is only invoked once the timer expires without another call. The pending
 * timer is automatically cancelled when the component unmounts.
 *
 * @param fn The function to debounce.
 * @param delayMs Debounce delay in milliseconds. Defaults to `DEFAULT_DEBOUNCE_DELAY`.
 * @returns A debounced wrapper around `fn` with the same signature.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- needed for a generic rest-args constraint that preserves the caller's function signature
export const useDebouncedCallback = <T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number = DEFAULT_DEBOUNCE_DELAY,
): T => {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedFn = useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        fn(...args);
      }, delayMs);
    },
    [fn, delayMs],
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debouncedFn as T;
};
