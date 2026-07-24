import { describe, expect, it } from 'vitest';

import { sessionTypeColor } from '#src/lib/session-rules';

describe('sessionTypeColor', () => {
  it('returns info for SCHEDULED', () => {
    expect(sessionTypeColor('SCHEDULED')).toBe('info');
  });

  it('returns success for ON_DEMAND', () => {
    expect(sessionTypeColor('ON_DEMAND')).toBe('success');
  });

  it('returns default for AUTO', () => {
    expect(sessionTypeColor('AUTO')).toBe('default');
  });
});
