import { useEffect, useState } from 'react';

import { deriveVisualizerPreferences } from '@scribear/visualizer-store';

function getViewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useBoundedVisualizer(
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
) {
  const [viewport, setViewport] = useState(getViewport);

  useEffect(() => {
    const handler = () => setViewport(getViewport());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return deriveVisualizerPreferences(
    targetX,
    targetY,
    targetWidth,
    targetHeight,
    viewport.width,
    viewport.height,
  );
}
