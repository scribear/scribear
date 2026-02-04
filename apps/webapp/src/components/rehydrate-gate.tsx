/**
 * Shows loading spinner and blocks page load when waiting for redux remember to rehydrate store with saved state
 * and triggers 'appStateReady' action once state is loaded
 */
import { selectIsRehydrated } from '@/stores/slices/redux-remember-slice';
import { useAppSelector } from '@/stores/use-redux';

import { PageLoadSpinner } from './ui/page-load-spinner';

interface RehydrateGateProps {
  children?: React.ReactNode;
}

export const RehydrateGate = ({ children }: RehydrateGateProps) => {
  const isRehydrated = useAppSelector(selectIsRehydrated);

  return isRehydrated ? children : <PageLoadSpinner />;
};
