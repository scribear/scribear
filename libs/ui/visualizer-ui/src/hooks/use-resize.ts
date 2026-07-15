import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizeDelta {
  w: number;
  h: number;
}

export function useResize(onCommit: (deltaW: number, deltaH: number) => void) {
  const [resizeDelta, setResizeDelta] = useState<ResizeDelta | null>(null);
  const startRef = useRef<{ mouseX: number; mouseY: number } | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { mouseX: e.clientX, mouseY: e.clientY };
    setResizeDelta({ w: 0, h: 0 });
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      setResizeDelta({
        w: e.clientX - startRef.current.mouseX,
        h: e.clientY - startRef.current.mouseY,
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!startRef.current) return;
      onCommitRef.current(
        e.clientX - startRef.current.mouseX,
        e.clientY - startRef.current.mouseY,
      );
      startRef.current = null;
      setResizeDelta(null);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return { resizeDelta, onMouseDown, isResizing: resizeDelta !== null };
}
