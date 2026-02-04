import { useEffect, useRef, useState } from 'react';

interface UseAutoScrollResult {
  isAutoScrollEnabled: boolean;
  setIsAutoScrollEnabled: (enabled: boolean) => void;
  textContainerRef: React.RefObject<Element | null>;
  textBottomRef: React.RefObject<Element | null>;
  handleScroll: () => void;
  scrollToBottom: () => void;
}

/**
 * Manages auto-scroll behavior for a scrollable text container.
 * Auto-scroll is disabled when user scrolls up, and re-enabled when near bottom.
 */
export const useAutoScroll = (dependencies: unknown[]): UseAutoScrollResult => {
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const lastScrollTopRef = useRef(0);
  const textBottomRef = useRef<Element>(null);
  const textContainerRef = useRef<Element>(null);

  const scrollToBottom = () => {
    textBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  const handleScroll = () => {
    const container = textContainerRef.current;
    if (!container) return;

    const { scrollHeight, scrollTop, clientHeight } = container;

    const isScrollingUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    const isNearBottom = scrollHeight - scrollTop - clientHeight < 10;

    if (isScrollingUp && !isNearBottom) {
      setIsAutoScrollEnabled(false);
    } else if (!isScrollingUp && isNearBottom) {
      setIsAutoScrollEnabled(true);
    }
  };

  useEffect(() => {
    if (isAutoScrollEnabled) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, isAutoScrollEnabled]);

  return {
    isAutoScrollEnabled,
    setIsAutoScrollEnabled,
    textContainerRef,
    textBottomRef,
    handleScroll,
    scrollToBottom,
  };
};
