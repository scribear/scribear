import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LineHeightControl } from '#src/components/preference-controls/line-height-control.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

describe('LineHeightControl', (it) => {
  it('announces the slider value with a unit (getAriaValueText)', () => {
    renderWithProviders(
      <LineHeightControl
        lineHeightMultipler={1.5}
        setLineHeightMultipler={vi.fn()}
      />,
    );

    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '1.5× line height',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(
      <LineHeightControl
        lineHeightMultipler={1.5}
        setLineHeightMultipler={vi.fn()}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
