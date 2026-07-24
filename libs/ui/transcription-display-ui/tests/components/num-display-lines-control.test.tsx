import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NumDisplayLinesControl } from '#src/components/preference-controls/num-display-lines-control.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

function renderControl() {
  return renderWithProviders(
    <NumDisplayLinesControl
      getNumDisplayLinesBounds={() => ({
        minNumDisplayLines: 1,
        maxNumDisplayLines: 20,
      })}
      getBoundedDisplayPreferences={() => ({
        verticalPositionPx: 0,
        numDisplayLines: 8,
      })}
      setTargetDisplayLines={vi.fn()}
    />,
  );
}

describe('NumDisplayLinesControl', (it) => {
  it('announces the slider value with a unit (getAriaValueText)', () => {
    renderControl();
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '8 lines',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderControl();
    expect(await axeViolations(container)).toEqual([]);
  });
});
