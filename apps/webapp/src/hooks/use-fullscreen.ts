/**
 * Hook for getting and setting page fullscreen state
 */
import { useCallback, useEffect, useState } from 'react';

export const useFullscreen = () => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isSupported = document.fullscreenEnabled;

  // Sync fullscreen state with browser state to handle external changes (e.g. if user presses ESC)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement !== null);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    await document.documentElement.requestFullscreen();
  }, []);

  const exitFullscreen = useCallback(async () => {
    await document.exitFullscreen();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [enterFullscreen, exitFullscreen]);

  return {
    isFullscreen,
    isSupported,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
  };
};
