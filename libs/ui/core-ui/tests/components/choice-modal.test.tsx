import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChoiceModal } from '#src/components/choice-modal.js';

import { axeViolations } from '../a11y.js';

const baseProps = {
  isOpen: true,
  message: 'Discard your changes?',
  rightAction: 'Discard',
  onCancel: vi.fn(),
  onRightAction: vi.fn(),
};

describe('ChoiceModal', (it) => {
  it('exposes dialog semantics named by its message', () => {
    render(<ChoiceModal {...baseProps} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // aria-labelledby is wired to the message so the dialog has an accessible name.
    expect(dialog).toHaveAccessibleName('Discard your changes?');
  });

  it('has no axe violations', async () => {
    render(<ChoiceModal {...baseProps} />);
    expect(await axeViolations()).toEqual([]);
  });
});
