import { useEffect, useState } from 'react';

/**
 * Tracks whether the user has interacted with the page recently.
 *
 * Returns `true` while the user is considered active and switches to `false`
 * after `timeoutMs` milliseconds of no mouse, keyboard, touch, or scroll
 * activity. Any new interaction resets the timer and restores the active state.
 *
 * @param timeoutMs Inactivity timeout in milliseconds.
 * @returns `true` if the user is currently active, `false` otherwise.
 */
export const useInactivity = (timeoutMs: number) => {
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

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
