import { useLayoutEffect, useRef } from 'react';

/**
 * Tracks the height of a container element using ResizeObserver
 */
export const useContainerHeight = (
  onHeightChange: (height: number) => void,
) => {
  const containerRef = useRef<Element>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height);
      }
    });

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [onHeightChange]);

  return containerRef;
};
