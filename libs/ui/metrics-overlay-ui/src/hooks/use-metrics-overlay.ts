import { useEffect, useMemo, useState } from 'react';

import type { MetricName } from '#src/metrics-fragment.js';
import {
  METRIC_NAMES,
  parseMetricsFragment,
} from '#src/metrics-fragment.js';

/** Key that toggles the metrics overlays on and off. */
const TOGGLE_KEY = 'm';

const NO_METRICS: ReadonlySet<MetricName> = new Set();

/**
 * Whether a keystroke landed in something the user is typing into, in which
 * case `m` is a character and not a shortcut.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * The metric overlays that should currently be rendered.
 *
 * Hidden by default; `#metrics=latency` (or `#metrics=all`) shows the named
 * overlays on load, and pressing `m` toggles them at any time. A bare `m` with
 * no fragment reveals every overlay, so the shortcut is useful on a link that
 * was not written with metrics in mind.
 *
 * The key is ignored when another handler already claimed the event, when a
 * modifier is held, or when focus is in a text field - "not captured by
 * anything else" is what makes a single unprefixed letter safe to bind.
 *
 * @returns The overlay names to render right now; empty when metrics are off.
 */
export function useMetricsOverlay(): ReadonlySet<MetricName> {
  // Read once on mount: the url-config middleware may strip the fragment after
  // consuming its own `config=` payload, and a toggle must not be undone by a
  // later re-read.
  const requested = useMemo(
    () => parseMetricsFragment(window.location.hash),
    [],
  );
  const [isShown, setIsShown] = useState(() => requested.size > 0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key.toLowerCase() !== TOGGLE_KEY) return;
      if (isTextEntryTarget(event.target)) return;
      setIsShown((shown) => !shown);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return useMemo(() => {
    if (!isShown) return NO_METRICS;
    return requested.size > 0 ? requested : new Set(METRIC_NAMES);
  }, [isShown, requested]);
}
