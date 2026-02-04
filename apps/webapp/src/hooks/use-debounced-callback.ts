import { useCallback, useEffect, useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useDebouncedCallback = <T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): T => {
  const timeoutRef = useRef<number | null>(null);

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

  // Clear the timeout if the component unmounts
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return debouncedFn as T;
};
