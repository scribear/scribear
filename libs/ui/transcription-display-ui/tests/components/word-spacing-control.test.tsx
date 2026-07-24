import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WordSpacingControl } from '#src/components/preference-controls/word-spacing-control.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

describe('WordSpacingControl', (it) => {
  it('announces the slider value with a unit (getAriaValueText)', () => {
    renderWithProviders(
      <WordSpacingControl wordSpacingEm={0.25} setWordSpacingEm={vi.fn()} />,
    );

    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '0.25em word spacing',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderWithProviders(
      <WordSpacingControl wordSpacingEm={0.25} setWordSpacingEm={vi.fn()} />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
