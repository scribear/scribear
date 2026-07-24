import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { JumpToBottomButton } from '#src/components/jump-to-bottom-button.js';

import { axeViolations } from '../a11y.js';
import { renderWithProviders } from '../render.js';

describe('JumpToBottomButton', (it) => {
  it('has an accessible name and fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<JumpToBottomButton visible onClick={onClick} />);

    const button = screen.getByRole('button', {
      name: 'Jump to latest transcription',
    });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('has no axe violations', async () => {
    renderWithProviders(<JumpToBottomButton visible onClick={vi.fn()} />);
    expect(await axeViolations()).toEqual([]);
  });
});
