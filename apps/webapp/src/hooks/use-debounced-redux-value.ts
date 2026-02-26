import { useEffect, useState } from 'react';

import type { Action } from '@reduxjs/toolkit';

import { useDebouncedCallback } from '#src/hooks/use-debounced-callback';
import type { RootState } from '#src/stores/store';
import { useAppDispatch, useAppSelector } from '#src/stores/use-redux';

export const useDebouncedReduxValue = <T>(
  selector: (state: RootState) => T,
  actionCreator: (value: T) => Action,
  delayMs: number,
): [T, (value: T) => void] => {
  const dispatch = useAppDispatch();
  const reduxValue = useAppSelector(selector);

  const [value, setValue] = useState<T>(reduxValue);

  useEffect(() => {
    // Required in order to sync redux state with local value
    // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
    setValue(reduxValue);
  }, [reduxValue]);

  const debouncedDispatch = useDebouncedCallback((value: T) => {
    dispatch(actionCreator(value));
  }, delayMs);

  const handleChange = (newValue: T) => {
    setValue(newValue);
    debouncedDispatch(newValue);
  };

  return [value, handleChange];
};
