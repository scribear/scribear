import type { Middleware } from '@reduxjs/toolkit';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { rememberRehydrated } from '@scribear/redux-remember-store';

import { setUrlConfigErrors } from './url-config-slice.js';

const CONFIG_FRAGMENT_PREFIX = 'config=';
const REDUX_REMEMBER_KEY_PREFIX = '@@remember-';

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

function parseFragment(): Record<string, unknown> | null {
  const hash = window.location.hash.slice(1);
  if (!hash.startsWith(CONFIG_FRAGMENT_PREFIX)) return null;

  const encoded = hash.slice(CONFIG_FRAGMENT_PREFIX.length);
  const json = atob(encoded);
  const parsed: unknown = JSON.parse(json);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
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

/**
 * Creates a Redux middleware that applies URL fragment config overrides
 * after redux-remember rehydration. On valid config, writes the merged
 * values to localStorage and reloads the page. On invalid config,
 * dispatches errors to the urlConfig slice.
 *
 * @param schemas - Map of slice keys to their typebox schemas. Only keys
 *   present in this map can be overridden via URL config.
 */
export const createUrlConfigMiddleware =
  (schemas: Record<string, TSchema>): Middleware =>
  (store) =>
  (next) =>
  (action) => {
    const result = next(action);

    if (!rememberRehydrated.match(action)) return result;

    let fragmentConfig: Record<string, unknown> | null;
    try {
      fragmentConfig = parseFragment();
    } catch (e) {
      clearFragment();
      store.dispatch(
        setUrlConfigErrors([
          e instanceof Error ? e.message : 'Failed to parse URL config',
        ]),
      );
      return result;
    }

    if (!fragmentConfig) return result;

    clearFragment();

    // Validate each key against its schema
    const errors: string[] = [];
    for (const [key, value] of Object.entries(fragmentConfig)) {
      if (!(key in schemas)) {
        errors.push(`"${key}": not a configurable key`);
        continue;
      }
      const schema = schemas[key];
      if (!schema) continue;
      if (!Value.Check(schema, value)) {
        for (const err of Value.Errors(schema, value)) {
          errors.push(`"${key}${err.instancePath}": ${err.message}`);
        }
      }
    }

    if (errors.length > 0) {
      store.dispatch(setUrlConfigErrors(errors));
      return result;
    }

    // Write validated overrides to localStorage and reload
    for (const [key, value] of Object.entries(fragmentConfig)) {
      const lsKey = REDUX_REMEMBER_KEY_PREFIX + key;
      const existing: unknown = JSON.parse(
        window.localStorage.getItem(lsKey) ?? '{}',
      );
      window.localStorage.setItem(
        lsKey,
        JSON.stringify(deepMerge(existing, value)),
      );
    }

    window.location.reload();
    return result;
  };
