import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ContrastReadout } from '#src/components/contrast-readout.js';

import { axeViolations } from '../a11y.js';

describe('ContrastReadout', (it) => {
  it('reports a passing pair as a polite status without a warning', () => {
    render(
      <ContrastReadout
        backgroundColor="#000000"
        accentColor="#ffffff"
        transcriptionColor="#ffffff"
      />,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Caption text: 21\.0:1/)).toBeInTheDocument();
    expect(screen.queryByText(/low, aim for/)).not.toBeInTheDocument();
  });

  it('warns (in text, not colour alone) when the accent fails 3:1', () => {
    // Default theme: caption #ffff00 on #000000 passes; accent #8b0000 fails.
    render(
      <ContrastReadout
        backgroundColor="#000000"
        accentColor="#8b0000"
        transcriptionColor="#ffff00"
      />,
    );

    expect(screen.getByText(/Accent:.*low, aim for 3:1/)).toBeInTheDocument();
    // The caption row is fine, so its text carries no warning.
    expect(screen.getByText(/Caption text:(?!.*low)/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ContrastReadout
        backgroundColor="#000000"
        accentColor="#8b0000"
        transcriptionColor="#ffff00"
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
