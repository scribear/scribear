import type { ReactElement } from 'react';

import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '#src/lib/toast-provider';

export const renderWithProviders = (
  ui: ReactElement,
  options?: RenderOptions & { route?: string },
) => {
  const { route = '/', ...renderOptions } = options ?? {};

  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    ),
    ...renderOptions,
  });
};
