// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch, RootState } from './store';

// Pre-typed `useDispatch` hook bound to the kiosk webapp's `AppDispatch` type.
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
// Pre-typed `useSelector` hook bound to the kiosk webapp's `RootState` type.
export const useAppSelector = useSelector.withTypes<RootState>();
