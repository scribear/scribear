import type { ReactElement } from 'react';

import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { SettingsProvider } from '#src/lib/settings-provider';
import { ToastProvider } from '#src/lib/toast-provider';

export const renderWithProviders = (
  ui: ReactElement,
  options?: RenderOptions & { route?: string },
) => {
  const { route = '/', ...renderOptions } = options ?? {};

  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>
          <SettingsProvider>{children}</SettingsProvider>
        </ToastProvider>
      </MemoryRouter>
    ),
    ...renderOptions,
  });
};
