import { AppMode } from '@/types/app-mode';

import { PATHS } from './paths';

export const DEFAULT_APP_MODE = AppMode.OTHER;

export const APP_MODE_PATHS = {
  [PATHS.client]: AppMode.CLIENT,
  [PATHS.kiosk]: AppMode.KIOSK,
  [PATHS.standalone]: AppMode.STANDALONE,
} as const;
