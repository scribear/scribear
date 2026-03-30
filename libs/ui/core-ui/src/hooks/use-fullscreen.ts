import { useCallback, useEffect, useState } from 'react';

/**
 * Manages fullscreen state for the document element.
 *
 * Tracks whether the document is currently in fullscreen mode and exposes
 * `enterFullscreen`, `exitFullscreen`, and `toggleFullscreen` async helpers.
 * `isSupported` reflects whether the Fullscreen API is available in the browser.
 *
 * @returns An object with `isFullscreen`, `isSupported`, `enterFullscreen`,
 *   `exitFullscreen`, and `toggleFullscreen`.
 */
export const useFullscreen = () => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isSupported = document.fullscreenEnabled;

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
