/**
 * WCAG relative-luminance / contrast helpers used to keep user-chosen theme
 * colors readable (SC 1.4.3 text contrast, SC 1.4.11 non-text contrast).
 *
 * All inputs are CSS hex strings ("#rgb" or "#rrggbb"); non-hex input yields a
 * safe fallback (treated as black) rather than throwing, since these run on
 * live, partially-typed color-picker values.
 */

// WCAG AA thresholds.
export const AA_TEXT_CONTRAST = 4.5; // normal text
export const AA_LARGE_TEXT_CONTRAST = 3; // >=24px (or >=18.66px bold)
export const AA_NON_TEXT_CONTRAST = 3; // UI components / graphical objects

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function linearize(channel8Bit: number): number {
  const c = channel8Bit / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (0 = black, 1 = white) per WCAG 2.1. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Contrast ratio between two colors, from 1:1 to 21:1. */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Black or white — whichever is more readable on `backgroundColor`. Used to set
 * `palette.text.primary` so default-colored text/icons stay visible on any
 * user-chosen background.
 */
export function readableTextColor(
  backgroundColor: string,
): '#000000' | '#ffffff' {
  return contrastRatio('#000000', backgroundColor) >=
    contrastRatio('#ffffff', backgroundColor)
    ? '#000000'
    : '#ffffff';
}

/** Whether a background is light enough to warrant MUI's `light` palette mode. */
export function isLightColor(backgroundColor: string): boolean {
  return readableTextColor(backgroundColor) === '#000000';
}
