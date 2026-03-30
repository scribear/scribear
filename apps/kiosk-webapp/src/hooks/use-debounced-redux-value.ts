import { useEffect, useState } from 'react';

import type { Action } from '@reduxjs/toolkit';

import { useDebouncedCallback } from '@scribear/core-ui';

import type { RootState } from '#src/store/store';
import { useAppDispatch, useAppSelector } from '#src/store/use-redux';

/**
 * Hook that keeps a local state value in sync with a Redux slice value while
 * debouncing writes back to the store. Returns a `[value, setter]` tuple where
 * the setter updates local state immediately but only dispatches to Redux after
 * `delayMs` of inactivity.
 */
export const useDebouncedReduxValue = <T>(
  selector: (state: RootState) => T,
  actionCreator: (value: T) => Action,
  delayMs: number,
): [T, (value: T) => void] => {
  const dispatch = useAppDispatch();
  const reduxValue = useAppSelector(selector);

  const [value, setValue] = useState<T>(reduxValue);

  useEffect(() => {
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setValue(reduxValue);
  }, [reduxValue]);

  const debouncedDispatch = useDebouncedCallback((v: T) => {
    dispatch(actionCreator(v));
  }, delayMs);

  const handleChange = (newValue: T) => {
    setValue(newValue);
    debouncedDispatch(newValue);
  };

  return [value, handleChange];
};
