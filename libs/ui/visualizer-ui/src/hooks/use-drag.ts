import { useCallback, useEffect, useRef, useState } from 'react';

export interface DragDelta {
  x: number;
  y: number;
}

export function useDrag(onCommit: (deltaX: number, deltaY: number) => void) {
  const [dragDelta, setDragDelta] = useState<DragDelta | null>(null);
  const startRef = useRef<{ mouseX: number; mouseY: number } | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startRef.current = { mouseX: e.clientX, mouseY: e.clientY };
    setDragDelta({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      setDragDelta({
        x: e.clientX - startRef.current.mouseX,
        y: e.clientY - startRef.current.mouseY,
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!startRef.current) return;
      onCommitRef.current(
        e.clientX - startRef.current.mouseX,
        e.clientY - startRef.current.mouseY,
      );
      startRef.current = null;
      setDragDelta(null);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return { dragDelta, onMouseDown, isDragging: dragDelta !== null };
}
