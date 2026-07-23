import { describe, expect } from 'vitest';

import {
  assertNotPlaceholderKey,
  constantTimeEqual,
} from '#src/server/utils/constant-time-equal.js';

describe('constantTimeEqual', (it) => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('super-secret-key', 'super-secret-key')).toBe(
      true,
    );
  });

  it('returns false for different same-length strings', () => {
    expect(constantTimeEqual('abcd', 'abce')).toBe(false);
  });

  it('returns false for different-length strings without throwing', () => {
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('x', '')).toBe(false);
  });
});

describe('assertNotPlaceholderKey', (it) => {
  it('throws when the key is the literal placeholder CHANGEME', () => {
    expect(() => {
      assertNotPlaceholderKey('CHANGEME', 'ADMIN_API_KEY');
    }).toThrow();
  });

  // Compose substitutes a blank string for an unset variable, so this is the
  // shape an .env predating a newly required key arrives in. It has to throw:
  // an empty configured key compares equal to the empty string a caller
  // presents as `Authorization: Bearer `, making the guard an auth bypass.
  it('throws when the key is empty', () => {
    expect(() => {
      assertNotPlaceholderKey('', 'ADMIN_API_KEY');
    }).toThrow();
  });

  it('does not throw for a real key', () => {
    expect(() => {
      assertNotPlaceholderKey('a-real-high-entropy-secret', 'ADMIN_API_KEY');
    }).not.toThrow();
  });
});
