import { PageLoadSpinner } from '@scribear/core-ui';
import { selectIsRehydrated } from '@scribear/redux-remember-store';

import { useAppSelector } from '#src/store/use-redux.js';

/**
 * Shows a loading spinner until `isRehydrated` is true, then renders children.
 */
export const RehydrateGate = ({ children }: React.PropsWithChildren) => {
  const isRehydrated = useAppSelector(selectIsRehydrated);

  return isRehydrated ? children : <PageLoadSpinner />;
};
