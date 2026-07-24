import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  isLightColor,
  readableTextColor,
  relativeLuminance,
} from '#src/utils/color-contrast.js';

describe('color-contrast', (it) => {
  it('computes luminance endpoints', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('gives 21:1 for black on white and 1:1 for equal colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#3499cb', '#3499cb')).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#ffff00', '#000000')).toBeCloseTo(
      contrastRatio('#000000', '#ffff00'),
      5,
    );
  });

  it('flags the known failing pairs from the audit', () => {
    // Default accent #8b0000 on black fails 3:1 non-text.
    expect(contrastRatio('#8b0000', '#000000')).toBeLessThan(3);
    // Old Sky Blue caption (white on #3499cb) failed AA text; the darkened
    // replacement (#1c6a94) clears it.
    expect(contrastRatio('#ffffff', '#3499cb')).toBeLessThan(4.5);
    expect(contrastRatio('#ffffff', '#1c6a94')).toBeGreaterThanOrEqual(4.5);
  });

  it('picks a readable text color and mode for a background', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(isLightColor('#ebebeb')).toBe(true);
    expect(isLightColor('#13294b')).toBe(false);
  });

  it('treats malformed input as black rather than throwing', () => {
    expect(relativeLuminance('not-a-color')).toBe(0);
    expect(relativeLuminance('#abc')).toBe(relativeLuminance('#aabbcc'));
  });
});
