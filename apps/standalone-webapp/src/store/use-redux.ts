// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch, RootState } from './store';

// Typed version of `useDispatch` bound to the standalone app's store.
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
// Typed version of `useSelector` bound to the standalone app's `RootState`.
export const useAppSelector = useSelector.withTypes<RootState>();
