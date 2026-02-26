/**
 * Provides typed versions of `useDispatch` and `useSelector`
 * Use throughout application instead of plain `useDispatch` and `useSelector`
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { useDispatch, useSelector } from 'react-redux';

import type { AppDispatch } from '#src/stores/store';

import type { RootState } from './store';

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
