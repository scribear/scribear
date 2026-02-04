import { useEffect } from 'react';

import { Outlet, useLocation } from 'react-router';

import { APP_MODE_PATHS, DEFAULT_APP_MODE } from '@/config/app-mode-paths';
import { appModeChange } from '@/core/app-mode/store/app-mode-slice';
import { useAppDispatch } from '@/stores/use-redux';

export const AppModeObserver = () => {
  const dispatch = useAppDispatch();
  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;

    if (path in APP_MODE_PATHS) {
      const appMode = APP_MODE_PATHS[path as keyof typeof APP_MODE_PATHS];
      dispatch(appModeChange(appMode));
    } else {
      dispatch(appModeChange(DEFAULT_APP_MODE));
    }
  }, [location, dispatch]);

  return <Outlet />;
};
