import { AppProvider } from './app-provider';
import { AppRouter } from './router';

/**
 * Root application component for the room webapp. Wraps the router
 * inside `AppProvider`, which supplies all required providers and Redux state.
 */
export const App = () => {
  return (
    <AppProvider>
      <AppRouter />
    </AppProvider>
  );
};
