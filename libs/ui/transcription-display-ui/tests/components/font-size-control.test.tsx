import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FontSizeControl } from '#src/components/preference-controls/font-size-control.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

describe('FontSizeControl', (it) => {
  it('announces the slider value with a unit (getAriaValueText)', () => {
    renderWithProviders(
      <FontSizeControl fontSizePx={32} setFontSizePx={vi.fn()} />,
    );

    // Without getAriaValueText MUI reads out a bare "32"; the unit makes it "32 pixels".
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '32 pixels',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(
      <FontSizeControl fontSizePx={32} setFontSizePx={vi.fn()} />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
