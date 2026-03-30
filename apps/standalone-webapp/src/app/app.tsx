import { AppProvider } from './app-provider';
import { Root } from './root';

/**
 * Top-level application component. Wraps the root UI in the application
 * provider tree (store, theme, error boundaries, etc.).
 */
export const App = () => {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
};
