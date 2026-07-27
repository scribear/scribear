import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, vi } from 'vitest';

import { CopyIconButton } from '#src/components/copy-icon-button';
import { renderWithProviders } from '#tests/utils/render-with-providers';

/**
 * The shared copy control. Its clipboard-failure behaviour is the part worth
 * testing: `navigator.clipboard` requires a secure context, so on a console
 * reached over plain HTTP — which is how local deployments are reached, and
 * exactly where an operator is most likely to be copying an activation code by
 * hand — the property does not exist at all.
 */
describe('CopyIconButton', () => {
  afterEach(() => {
    // jsdom ships no Clipboard API, which is the insecure-context shape. Any
    // test that installs one has to put it back.
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // Plain `fireEvent`, not `userEvent`: `userEvent.setup()` unconditionally
  // installs its own jsdom clipboard stub, which would mask the unavailable
  // branch under test and clobber the `writeText` mock below.
  describe('copying', (it) => {
    it('names what it copies, so two of these are not ambiguous', () => {
      // Arrange — the register-device dialog shows a "Copy activation code"
      // and a "Copy kiosk URL" button side by side; an icon alone would leave
      // a screen reader user unable to tell them apart.
      renderWithProviders(<CopyIconButton value="ABC123" label="join code" />);

      // Assert
      expect(
        screen.getByRole('button', { name: 'Copy join code' }),
      ).toBeInTheDocument();
    });

    it('puts the value on the clipboard', async () => {
      // Arrange
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      renderWithProviders(<CopyIconButton value="ABC123" label="join code" />);

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Copy join code' }));

      // Assert
      expect(writeText).toHaveBeenCalledWith('ABC123');
      expect(
        await screen.findByRole('button', { name: 'Copy join code' }),
      ).toBeInTheDocument();
    });

    it('says so when the clipboard is unavailable rather than doing nothing', async () => {
      // Arrange — no clipboard stub, which is jsdom's default and stands in for
      // an insecure context. `navigator.clipboard` is `undefined` there, so
      // `.writeText` throws *synchronously*: a lone `.catch()` never runs, and
      // the button used to appear inert while the error went to the console.
      renderWithProviders(<CopyIconButton value="ABC123" label="join code" />);

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Copy join code' }));

      // Assert — the toast is an assertive `role="alert"` region, so this
      // reaches a screen reader and not only the eye.
      expect(
        await screen.findByText(/clipboard access isn.t available/i),
      ).toBeInTheDocument();
    });

    it('reports a rejected write too', async () => {
      // Arrange — a browser that has the API but denies the permission. Same
      // remedy for the operator, different failure mode.
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
      });
      renderWithProviders(<CopyIconButton value="ABC123" label="join code" />);

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Copy join code' }));

      // Assert
      expect(
        await screen.findByText(/couldn.t copy the join code/i),
      ).toBeInTheDocument();
    });
  });
});
