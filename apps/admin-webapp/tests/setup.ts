import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// `test.globals` isn't enabled in this project, so @testing-library/react's
// automatic afterEach(cleanup) (which only registers when it finds a global
// `afterEach`) never fires — register it explicitly so DOM/portals from one
// test don't leak into the next.
afterEach(() => {
  cleanup();
});
