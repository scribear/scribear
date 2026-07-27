import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Default quiet period before a debounced change is propagated upstream.
 *
 * Matches `DEFAULT_DEBOUNCE_DELAY` in `@scribear/core-ui`, which the shared
 * preference sliders use. Restated rather than imported: admin-webapp has no
 * `libs/ui` dependency (it would pull the transcription display's whole
 * dependency graph into this bundle for one number and one hook).
 */
export const DEFAULT_DEBOUNCE_DELAY_MS = 300;

/**
 * Bridges an upstream controlled value with a locally responsive copy.
 *
 * `localValue` follows the upstream `value` whenever it changes, and follows
 * `handleChange` immediately; `setter` is only called after `delayMs` of
 * quiet. That is what lets a slider track a dragging hand at 60fps while the
 * request it triggers goes out once.
 *
 * Same contract as `useDebouncedValue` in `@scribear/core-ui` — see above for
 * why it is restated here rather than imported.
 */
export function useDebouncedValue<T>(
  value: T,
  setter: (v: T) => void,
  delayMs: number = DEFAULT_DEBOUNCE_DELAY_MS,
): [T, (v: T) => void] {
  const [localValue, setLocalValue] = useState<T>(value);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect, @eslint-react/set-state-in-effect -- intentional sync of the upstream value into the local copy; this is the hook's whole job.
    setLocalValue(value);
  }, [value]);

  // Held in a ref so a caller passing an inline arrow (every caller) does not
  // restart the timer on each render — which would mean the setter never fires
  // while a re-render is happening, i.e. exactly while a slider is being
  // dragged.
  const setterRef = useRef(setter);
  useEffect(() => {
    setterRef.current = setter;
  }, [setter]);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (newValue: T) => {
      setLocalValue(newValue);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setterRef.current(newValue);
      }, delayMs);
    },
    [delayMs],
  );

  return [localValue, handleChange];
}
