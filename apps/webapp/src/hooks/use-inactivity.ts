/**
 * Hook for determining if a user is active or inactive
 * If the user does not perform any identifiable action for period of time, user is determined inactive
 */
import { useEffect, useState } from 'react';

export const useInactivity = (timeoutMs: number) => {
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    let timeoutId: number;

    const setInactiveTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setIsActive(false);
      }, timeoutMs);
    };

    const resetTimer = () => {
      setIsActive(true);
      setInactiveTimer();
    };

    const interactionEvents = [
      'mousemove',
      'mousedown',
      'touchstart',
      'keydown',
      'scroll',
    ];
    interactionEvents.forEach((event) => {
      window.addEventListener(event, resetTimer);
    });

    // Start timer immediately on load
    setInactiveTimer();

    return () => {
      clearTimeout(timeoutId);
      interactionEvents.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });
    };
  }, [timeoutMs]);

  return isActive;
};
