import { useLayoutEffect, useRef } from 'react';

/**
 * Returns a ref to attach to a container element. Calls `onHeightChange`
 * whenever the element's height changes via ResizeObserver.
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
