import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CancelableInfoModal } from '#src/components/cancelable-info-modal.js';

import { axeViolations } from '../a11y.js';

const baseProps = {
  isOpen: true,
  message: 'Microphone access was denied.',
  onCancel: vi.fn(),
};

describe('CancelableInfoModal', (it) => {
  it('exposes dialog semantics named by its message', () => {
    render(<CancelableInfoModal {...baseProps} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Microphone access was denied.');
  });

  it('has no axe violations', async () => {
    render(<CancelableInfoModal {...baseProps} />);
    expect(await axeViolations()).toEqual([]);
  });
});
