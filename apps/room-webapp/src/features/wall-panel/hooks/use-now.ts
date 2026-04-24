import { useEffect, useState } from 'react';

/**
 * Returns the current timestamp in ms, updating on an interval. Default cadence
 * is once per second so digital-clock UIs tick in real time. Pass a larger
 * interval for components that only need minute-level refreshes (e.g. countdowns).
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}
