export type VisualizerKind = 'frequency' | 'waveform' | 'mfcc';

export type Rect = { x: number; y: number; w: number; h: number };

export type VisualizerPrefs = {
  enabled: Record<VisualizerKind, boolean>;
  layout: Record<VisualizerKind, Rect>;
};

const KEY = 'scribear.microphone.visualizers.v1';

export const DEFAULT_PREFS: VisualizerPrefs = {
  enabled: {
    frequency: true,
    waveform: true,
    mfcc: false,
  },
  layout: {
    frequency: { x: 24, y: 120, w: 420, h: 240 },
    waveform: { x: 24, y: 380, w: 420, h: 180 },
    mfcc: { x: 480, y: 120, w: 420, h: 240 },
  },
};

export function loadVisualizerPrefs(): VisualizerPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as VisualizerPrefs;
    return {
      enabled: { ...DEFAULT_PREFS.enabled, ...(parsed.enabled ?? {}) },
      layout: { ...DEFAULT_PREFS.layout, ...(parsed.layout ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveVisualizerPrefs(prefs: VisualizerPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}