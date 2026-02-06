import type { Rect } from './visualizer-preferences';

const MIN_W = 220;
const MIN_H = 140;

export function resolveRect(preferred: Rect, viewportW: number, viewportH: number): Rect {
  // enforce minimum size
  const w = Math.max(MIN_W, preferred.w);
  const h = Math.max(MIN_H, preferred.h);

  // clamp position so the rect stays fully visible
  const x = clamp(preferred.x, 0, Math.max(0, viewportW - w));
  const y = clamp(preferred.y, 0, Math.max(0, viewportH - h));

  return { x, y, w, h };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}