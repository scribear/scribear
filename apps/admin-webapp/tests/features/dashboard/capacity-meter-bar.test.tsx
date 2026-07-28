import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, expect } from 'vitest';

import { CapacityMeterBar } from '#src/features/dashboard/capacity-meter-bar';
import type { ProviderCapacity } from '#src/features/dashboard/fleet-status';

function buildCapacity(
  overrides: Partial<ProviderCapacity> = {},
): ProviderCapacity {
  return {
    applicable: true,
    liveSessions: 2,
    estimatedCapacitySessions: 6,
    ...overrides,
  };
}

describe('CapacityMeterBar', (it) => {
  it('has no a11y violations with a measured estimate', async () => {
    const { container } = render(
      <CapacityMeterBar
        capacity={buildCapacity()}
        label="Capacity for provider whisper"
      />,
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('has no a11y violations while warming up', async () => {
    const { container } = render(
      <CapacityMeterBar
        capacity={buildCapacity({ estimatedCapacitySessions: null })}
        label="Capacity for provider whisper"
      />,
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('has no a11y violations when not applicable', async () => {
    const { container } = render(
      <CapacityMeterBar
        capacity={buildCapacity({ applicable: false })}
        label="Capacity for provider lumen_granite"
      />,
    );

    const results = await axe(container);
    expect(results.violations).toHaveLength(0);
  });

  it('renders "not applicable" and no bar for a non-local provider', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({
          applicable: false,
          liveSessions: 1,
          estimatedCapacitySessions: null,
        })}
        label="Capacity for provider lumen_granite"
      />,
    );

    expect(screen.getByText('not applicable')).toBeInTheDocument();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('renders the live/estimated readout as visible text beside the bar', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({
          liveSessions: 2,
          estimatedCapacitySessions: 6,
        })}
        label="Capacity for provider whisper"
      />,
    );

    expect(document.body).toHaveTextContent('2 / 6');
  });

  it('renders "warming up" instead of a number when the estimate is null', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({
          liveSessions: 1,
          estimatedCapacitySessions: null,
        })}
        label="Capacity for provider whisper"
      />,
    );

    expect(document.body).toHaveTextContent('1 / warming up');
  });

  it('renders the bar indeterminate (no aria-valuenow) while warming up', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({ estimatedCapacitySessions: null })}
        label="Capacity for provider whisper"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar?.getAttribute('aria-valuetext')).toContain(
      'capacity not yet measured',
    );
  });

  it('exposes aria-valuenow/min/max once the estimate is known', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({
          liveSessions: 2,
          estimatedCapacitySessions: 6,
        })}
        label="Capacity for provider whisper"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('2');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('6');
    expect(bar?.getAttribute('aria-valuetext')).toBe(
      '2 of 6 estimated sessions, within capacity',
    );
  });

  it('reports crit in aria-valuetext when live exceeds the estimate', () => {
    render(
      <CapacityMeterBar
        capacity={buildCapacity({
          liveSessions: 5,
          estimatedCapacitySessions: 4,
        })}
        label="Capacity for provider whisper"
      />,
    );

    const bar = document.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuetext')).toContain('over capacity');
  });
});
