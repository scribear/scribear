/**
 * React router for displaying different versions of page based on mode selected by url path
 */
import type { ComponentType } from 'react';

import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { MainErrorFallback } from '#src/components/ui/main-error-fallback';
import { PageLoadSpinner } from '#src/components/ui/page-load-spinner';
import { PATHS } from '#src/config/paths';
import { AppModeObserver } from '#src/core/app-mode/components/app-mode-observer';

// Helper to map the default export to 'Component' for React Router lazy loading
const lazyLoad = async (importPromise: Promise<{ default: ComponentType }>) => {
  const Component = (await importPromise).default;
  return { Component };
};

const createAppRouter = () =>
  createBrowserRouter([
    {
      element: <AppModeObserver />,
      errorElement: <MainErrorFallback />,
      children: [
        // Landing page
        {
          path: PATHS.landing,
          errorElement: <MainErrorFallback />,
          hydrateFallbackElement: <PageLoadSpinner />,
          lazy: () => lazyLoad(import('./routes/landing')),
        },
        // Standalone mode
        {
          path: PATHS.standalone,
          errorElement: <MainErrorFallback />,
          hydrateFallbackElement: <PageLoadSpinner />,
          lazy: () => lazyLoad(import('./routes/standalone/root')),
        },
        // Kiosk mode
        {
          path: PATHS.kiosk,
          errorElement: <MainErrorFallback />,
          hydrateFallbackElement: <PageLoadSpinner />,
          lazy: () => lazyLoad(import('./routes/kiosk/root')),
        },
        // Client mode
        {
          path: PATHS.client,
          errorElement: <MainErrorFallback />,
          hydrateFallbackElement: <PageLoadSpinner />,
          lazy: () => lazyLoad(import('./routes/client/root')),
        },
        // Fallback
        {
          path: '*',
          errorElement: <MainErrorFallback />,
          hydrateFallbackElement: <PageLoadSpinner />,
          lazy: () => lazyLoad(import('./routes/not-found')),
        },
      ],
    },
  ]);

export const AppRouter = () => {
  const router = createAppRouter();
  return <RouterProvider router={router} />;
};
