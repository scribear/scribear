import { describe, expect } from 'vitest';

import {
  assertNotPlaceholderKey,
  constantTimeEqual,
  isPlaceholderSecret,
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
      assertNotPlaceholderKey('CHANGEME', 'NODE_SERVER_SERVICE_API_KEY');
    }).toThrow();
  });

  // These are the .env.example stubs whose suffix exists only to satisfy a
  // minimum-length rule, so they are precisely the ones an operator is most
  // likely to keep verbatim — and precisely the ones an equality check on
  // 'CHANGEME' would wave through.
  it.each([
    'CHANGEME-JWT-must-be-at-least-32-characters-long',
    'CHANGEME-admin-session-secret-at-least-32-characters',
    'engrit CHANGEME',
    'changeme',
  ])('throws when the key merely contains the placeholder: %s', (value) => {
    expect(() => {
      assertNotPlaceholderKey(value, 'SESSION_TOKEN_SIGNING_KEY');
    }).toThrow();
  });

  // Compose substitutes a blank string for an unset variable, so this is the
  // shape an .env predating a newly required key arrives in. It has to throw:
  // an empty configured key compares equal to the empty string a caller
  // presents as `Authorization: Bearer `, making the guard an auth bypass.
  it('throws when the key is empty', () => {
    expect(() => {
      assertNotPlaceholderKey('', 'NODE_SERVER_SERVICE_API_KEY');
    }).toThrow();
  });

  it('does not throw for a real key', () => {
    expect(() => {
      assertNotPlaceholderKey(
        'a-real-high-entropy-secret',
        'NODE_SERVER_SERVICE_API_KEY',
      );
    }).not.toThrow();
  });
});

// Newly load-bearing (AppConfig.secretPlaceholders now calls this directly)
// though the empty/CHANGEME logic itself predates that caller.
describe('isPlaceholderSecret', (it) => {
  it('is true for an empty string', () => {
    expect(isPlaceholderSecret('')).toBe(true);
  });

  it('is true for the literal placeholder, case-insensitively', () => {
    expect(isPlaceholderSecret('CHANGEME')).toBe(true);
    expect(isPlaceholderSecret('changeme')).toBe(true);
    expect(isPlaceholderSecret('ChangeMe')).toBe(true);
  });

  it('is true when the placeholder is only a substring', () => {
    expect(isPlaceholderSecret('prefix-CHANGEME-suffix')).toBe(true);
    expect(
      isPlaceholderSecret('CHANGEME-JWT-must-be-at-least-32-characters-long'),
    ).toBe(true);
  });

  it('is false for whitespace-only', () => {
    // Not empty and not the marker - left alone deliberately, the same
    // restraint the rest of this check applies (no trimming, no strength rule).
    expect(isPlaceholderSecret('   ')).toBe(false);
  });

  it('is false for a real, non-placeholder secret', () => {
    expect(isPlaceholderSecret('a-real-high-entropy-secret')).toBe(false);
  });
});
