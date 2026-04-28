import { AppProvider } from './app-provider';
import { Root } from './root';

/**
 * Root application component for the kiosk webapp. Wraps the `Root` page
 * inside `AppProvider`, which supplies all required providers and Redux state.
 */
export const App = () => {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
};
