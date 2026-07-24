import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VerticalPositionControl } from '#src/components/preference-controls/vertical-position-control.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

function renderControl() {
  return renderWithProviders(
    <VerticalPositionControl
      getVerticalPositionBoundsPx={() => ({
        minVerticalPositionPx: 0,
        maxVerticalPositionPx: 400,
      })}
      getBoundedDisplayPreferences={() => ({
        verticalPositionPx: 120,
        numDisplayLines: 8,
      })}
      setTargetVerticalPositionPx={vi.fn()}
    />,
  );
}

describe('VerticalPositionControl', (it) => {
  it('announces the slider value with a unit (getAriaValueText)', () => {
    renderControl();
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '120 pixels from top',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderControl();
    expect(await axeViolations(container)).toEqual([]);
  });
});
