import { AppProvider } from './app-provider';
import { Root } from './root';

/**
 * Root application component. Wraps the `Root` page inside `AppProvider`,
 * which supplies the Redux store, theme, and all required context providers.
 */
export const App = () => {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
};
