import { AppProvider } from './app-provider';
import { AppRoutes } from './router';

/**
 * Root application component. Wraps the routed pages in the top-level provider
 * composition (theme, error boundary, toasts, router, auth).
 */
export const App = () => {
  return (
    <AppProvider>
      <AppRoutes />
    </AppProvider>
  );
};
