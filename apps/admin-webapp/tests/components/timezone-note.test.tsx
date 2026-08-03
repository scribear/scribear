import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, vi } from 'vitest';

import { TimezoneNote } from '#src/components/timezone-note';
import { browserTimeZone } from '#src/lib/timezone';

import { renderWithProviders } from '../utils/render-with-providers';

// The note's whole job is comparing the room's zone against the operator's, so
// the operator's zone is stubbed rather than inherited from whatever machine
// runs the suite.
vi.mock('#src/lib/timezone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/lib/timezone')>();
  return { ...actual, browserTimeZone: vi.fn() };
});

describe('TimezoneNote', () => {
  beforeEach(() => {
    vi.mocked(browserTimeZone).mockReturnValue('America/Chicago');
  });

  describe('room zone differs from the browser zone', (it) => {
    it('names both zones and says which one the page is using', () => {
      // Act
      renderWithProviders(<TimezoneNote timezone="Europe/London" />);

      // Assert - the operator must be able to see, without arithmetic, that
      // the times on the page are not their own.
      expect(screen.getByText(/Europe\/London/)).toBeInTheDocument();
      expect(screen.getByText(/America\/Chicago/)).toBeInTheDocument();
      expect(screen.getByText(/not your own/i)).toBeInTheDocument();
    });

    it('escalates to an error-coloured warning icon, not a quiet caption', () => {
      // Act
      const { container } = renderWithProviders(
        <TimezoneNote timezone="Europe/London" />,
      );

      // Assert - MUI stamps its error palette class onto the svg.
      expect(
        container.querySelector('svg.MuiSvgIcon-colorError'),
      ).not.toBeNull();
    });
  });

  describe('room zone matches the browser zone', (it) => {
    it('states the zone without warning', () => {
      // Act
      const { container } = renderWithProviders(
        <TimezoneNote timezone="America/Chicago" />,
      );

      // Assert
      expect(screen.getByText(/matches your own/i)).toBeInTheDocument();
      expect(screen.queryByText(/not your own/i)).not.toBeInTheDocument();
      expect(container.querySelector('svg.MuiSvgIcon-colorError')).toBeNull();
    });
  });

  describe('no room zone (deployment-wide times)', (it) => {
    it('states the browser zone and never warns', () => {
      // Act
      const { container } = renderWithProviders(<TimezoneNote />);

      // Assert - only one zone is in play, so there is nothing to warn about;
      // the page still says which one it is.
      expect(screen.getByText(/your timezone/i)).toBeInTheDocument();
      expect(screen.getByText(/America\/Chicago/)).toBeInTheDocument();
      expect(container.querySelector('svg.MuiSvgIcon-colorError')).toBeNull();
    });
  });

  describe('ownerLabel', (it) => {
    it('names what the zone belongs to', () => {
      // Act
      renderWithProviders(
        <TimezoneNote timezone="Europe/London" ownerLabel="session" />,
      );

      // Assert
      expect(screen.getByText(/session's timezone/i)).toBeInTheDocument();
    });
  });
});
