/**
 * Counters describing why auto-scroll engaged or disengaged, for one caption
 * region. A kiosk in a lecture hall cannot be reproduced against on a laptop,
 * so the interesting events are counted in the field rather than inferred.
 */
export interface AutoScrollDiagnostics {
  // Times auto-scroll was switched off by a scroll attributed to a real user
  // gesture. Expected to stay 0 on an untouched kiosk.
  userDisengagements: number;
  // Scroll events that would have disengaged under the old direction-based
  // rule but were ignored for having no user gesture behind them. Non-zero
  // here is healthy: it counts how often the old code would have misfired.
  suppressedDisengagements: number;
  // Distance from the bottom at the last suppressed event, for triage.
  lastSuppressedDistancePx: number;
  // Times the idle timer returned the view to the bottom after a scrollback.
  // A high count means the disengage threshold is too eager and readers are
  // being dropped out of follow mode by accident.
  idleReengagements: number;
}

/**
 * Records diagnostics for a single `useAutoScroll` instance.
 */
export interface AutoScrollDiagnosticsRecorder {
  recordSuppressed: (distancePx: number) => void;
  recordUserDisengage: (distancePx: number) => void;
  recordIdleReengage: () => void;
  snapshot: () => AutoScrollDiagnostics;
  // Publishes these counters on the global registry. Call from an effect and
  // pair with `dispose`; see the note on `register` below for why creation
  // deliberately does not publish.
  register: () => void;
  dispose: () => void;
}

/** Shape published on `window` when diagnostics are switched on. */
type DiagnosticsRegistry = Record<string, AutoScrollDiagnostics>;

/**
 * The global under which the registry is published. Named with a double
 * underscore by convention for a debug-only hook, which is why it is reached
 * through a cast rather than a `declare global` - the latter would put a
 * non-conforming identifier into the ambient scope of every consumer.
 */
interface GlobalWithDiagnostics {
  /*
   * The double underscore is the established convention for a debug-only global
   * that is explicitly not a public API (cf. __REACT_DEVTOOLS_GLOBAL_HOOK__),
   * and it is what anyone inspecting a kiosk in Web Inspector is told to look
   * for - so the naming rule is suppressed rather than the name changed.
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __scribearAutoScroll?: DiagnosticsRegistry;
}

const globalWithDiagnostics = globalThis as unknown as GlobalWithDiagnostics;

/**
 * Reads the counters currently published for `label`, or undefined if no such
 * caption region is mounted. Exists so tests and tooling do not have to reach
 * through an untyped global.
 *
 * @param label The instance label passed to `useAutoScroll`.
 */
export function readAutoScrollDiagnostics(
  label: string,
): AutoScrollDiagnostics | undefined {
  return globalWithDiagnostics.__scribearAutoScroll?.[label];
}

/**
 * Whether counters should be published on `window`.
 *
 * Always, deliberately: counting runs regardless (it is two integer increments
 * per scroll event), so gating publication behind a build flag or a
 * localStorage key would save nothing measurable while making a kiosk in a
 * lecture hall un-diagnosable without a redeploy. The registry is a handful of
 * numbers and is removed on unmount.
 */
function isPublicationEnabled(): boolean {
  return typeof globalThis !== 'undefined';
}

/**
 * Creates a diagnostics recorder for one caption region.
 *
 * Counting always runs - it is a couple of integer increments per scroll event
 * - and only publication to `window` is gated. The registry is keyed by label
 * because two caption regions (the transcript and the translated captions) are
 * mounted at once on the kiosk, and a single shared object would let whichever
 * mounted last silently erase the other's numbers.
 *
 * @param label Identifies this instance in the published registry.
 */
export function createAutoScrollDiagnostics(
  label: string,
): AutoScrollDiagnosticsRecorder {
  const counters: AutoScrollDiagnostics = {
    userDisengagements: 0,
    suppressedDisengagements: 0,
    lastSuppressedDistancePx: 0,
    idleReengagements: 0,
  };

  const published = isPublicationEnabled();

  return {
    recordSuppressed: (distancePx: number) => {
      counters.suppressedDisengagements += 1;
      counters.lastSuppressedDistancePx = distancePx;
    },
    recordUserDisengage: () => {
      counters.userDisengagements += 1;
    },
    recordIdleReengage: () => {
      counters.idleReengagements += 1;
    },
    snapshot: () => ({ ...counters }),
    /*
     * Publishing happens here rather than at creation so that it is symmetric
     * with `dispose`. Publishing at creation breaks under StrictMode: the
     * recorder is created once during render, but the effect that owns it is
     * mounted, torn down and remounted, so the teardown removed the entry and
     * nothing ever put it back - leaving `window.__scribearAutoScroll` empty in
     * development, which is exactly where someone would go looking for it.
     */
    register: () => {
      if (!published) return;
      globalWithDiagnostics.__scribearAutoScroll ??= {};
      globalWithDiagnostics.__scribearAutoScroll[label] = counters;
    },
    dispose: () => {
      if (!published) return;
      const registry = globalWithDiagnostics.__scribearAutoScroll;
      // Only drop the entry if it is still ours; a remount may already have
      // registered a replacement under the same label.
      if (registry?.[label] === counters) {
        Reflect.deleteProperty(registry, label);
      }
    },
  };
}
