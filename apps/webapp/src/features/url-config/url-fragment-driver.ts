/**
 * Custom redux-remember driver that wraps localStorage and merges in
 * config from the URL fragment during rehydration.
 *
 * Fragment format: #config=<base64-encoded JSON>
 * The JSON object maps remembered slice keys to partial state overrides.
 * Example: { "themePreferences": { "backgroundColor": "#ff0000" }, "providerConfig": { "AZURE": { "apiKey": "sk-demo" } } }
 *
 * Merges reducer defaults -> localStorage -> fragment overrides
 * The fragment is cleared from the URL after being read.
 */
import type { Reducer, UnknownAction } from '@reduxjs/toolkit';
import type { Driver } from 'redux-remember';

const CONFIG_FRAGMENT_PREFIX = 'config=';
const REDUX_REMEMBER_KEY_PREFIX = '@@remember-';

let urlConfigErrors: string[] | null = null;

/**
 * Returns validation errors from the last URL fragment config parse,
 * or null if there was no fragment or it was valid.
 */
export function getUrlConfigErrors(): string[] | null {
  return urlConfigErrors;
}

function parseFragment(): Record<string, unknown> | null {
  const hash = window.location.hash.slice(1); // remove leading #
  if (!hash.startsWith(CONFIG_FRAGMENT_PREFIX)) return null;

  const encoded = hash.slice(CONFIG_FRAGMENT_PREFIX.length);

  const json = atob(encoded);
  const parsed: unknown = JSON.parse(json);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('URL config must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function clearFragment(): void {
  history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );
}

function deepMerge(target: unknown, source: unknown): unknown {
  if (
    typeof target !== 'object' ||
    typeof source !== 'object' ||
    target === null ||
    source === null ||
    Array.isArray(target) ||
    Array.isArray(source)
  ) {
    return source;
  }

  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(
    source as Record<string, unknown>,
  )) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

/**
 * Validates that override values match the types of the corresponding
 * default state values. Returns a list of error messages.
 */
function validateOverride(
  override: unknown,
  defaultState: unknown,
  path: string,
): string[] {
  if (defaultState === null || defaultState === undefined) {
    return [];
  }

  if (typeof defaultState !== typeof override) {
    return [
      `"${path}": expected ${typeof defaultState}, got ${typeof override}`,
    ];
  }

  if (
    typeof defaultState !== 'object' ||
    typeof override !== 'object' ||
    override === null ||
    Array.isArray(defaultState) ||
    Array.isArray(override)
  ) {
    return [];
  }

  const errors: string[] = [];
  const defaultObj = defaultState as Record<string, unknown>;
  const overrideObj = override as Record<string, unknown>;

  for (const key of Object.keys(overrideObj)) {
    if (!(key in defaultObj)) {
      errors.push(`"${path}.${key}": unknown key`);
      continue;
    }
    errors.push(
      ...validateOverride(overrideObj[key], defaultObj[key], `${path}.${key}`),
    );
  }

  return errors;
}

type ReducersMap = Record<string, Reducer>;

function getDefaultStates(
  reducers: ReducersMap,
  keys: readonly string[],
): Record<string, unknown> {
  const dummyAction: UnknownAction = { type: '@@url-config/INIT' };
  const defaults: Record<string, unknown> = {};
  for (const key of keys) {
    if (reducers[key]) {
      defaults[key] = reducers[key](undefined, dummyAction);
    }
  }
  return defaults;
}

/**
 * Creates a redux-remember driver that overlays URL fragment config
 * on top of localStorage during rehydration reads.
 *
 * @param reducers - The reducers map, used to derive default state for each slice
 * @param allowedKeys - Slice keys that may be set via URL fragment
 */
export function createUrlFragmentDriver(
  reducers: ReducersMap,
  allowedKeys: readonly string[],
): Driver {
  const allowedKeySet = new Set(allowedKeys);
  const defaultStates = getDefaultStates(reducers, allowedKeys);

  let fragmentConfig: Record<string, unknown> | null = null;

  try {
    fragmentConfig = parseFragment();
  } catch (e) {
    urlConfigErrors = [
      e instanceof Error ? e.message : 'Failed to parse URL config',
    ];
    clearFragment();
  }

  if (fragmentConfig) {
    clearFragment();

    const errors: string[] = [];

    // Validate: check for disallowed keys
    for (const key of Object.keys(fragmentConfig)) {
      if (!allowedKeySet.has(key)) {
        errors.push(`"${key}": not a configurable key`);
      }
    }

    // Validate: check value shapes against defaults
    for (const [sliceKey, override] of Object.entries(fragmentConfig)) {
      if (!allowedKeySet.has(sliceKey)) continue;
      const defaultState = defaultStates[sliceKey];
      if (defaultState !== undefined) {
        errors.push(...validateOverride(override, defaultState, sliceKey));
      }
    }

    if (errors.length > 0) {
      urlConfigErrors = errors;
      fragmentConfig = null;
    }
  }

  return {
    getItem(key: string) {
      const stored = window.localStorage.getItem(key);

      if (!fragmentConfig) return stored;

      // redux-remember prefixes keys with @@remember-
      const sliceKey = key.replace(REDUX_REMEMBER_KEY_PREFIX, '');

      if (!allowedKeySet.has(sliceKey)) return stored;

      const fragmentOverride = fragmentConfig[sliceKey];
      if (fragmentOverride === undefined) return stored;

      // Merge defaults -> localStorage -> fragment overrides
      const defaultState = defaultStates[sliceKey] ?? {};
      const storedValue: unknown = stored ? JSON.parse(stored) : {};
      const merged = deepMerge(
        deepMerge(defaultState, storedValue),
        fragmentOverride,
      );
      return JSON.stringify(merged);
    },

    setItem(key: string, value: string) {
      window.localStorage.setItem(key, value);
    },
  };
}
