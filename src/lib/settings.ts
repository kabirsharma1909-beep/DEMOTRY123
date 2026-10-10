/**
 * Settings store — persisted to localStorage.
 * All video/landmark data stays in-memory only.
 */

export interface AppSettings {
  // Tracking mode
  trackingMode: 'hand' | 'head' | 'off';
  clickMode: 'gesture' | 'dwell' | 'both';

  // Gesture click
  gestureClickMs: number; // default 350

  // Dwell click
  dwellEnabled: boolean;
  dwellMs: number; // default 2000
  dwellStabilityPx: number; // default 60 (normalized × 1000)

  // Cursor
  cursorSensitivity: number; // 0.5 – 2.0, default 1.0
  cursorSmoothing: number; // OneEuro minCutoff, 0.5 – 5.0, default 1.5
  cursorBeta: number; // OneEuro beta, default 0.007

  // Scroll
  scrollSpeed: number; // multiplier 0.5 – 3.0, default 1.0

  // Head tracking
  headSensitivity: number; // default 1.2
  headNeutralZone: number; // 0 – 0.15, default 0.03

  // Visual
  activeFilter: string; // 'none' | 'landmarks' | 'glasses' | 'outline' | 'ears'
  showLandmarkOverlay: boolean;

  // Misc
  autoStartCamera: boolean;
}

const DEFAULTS: AppSettings = {
  trackingMode: 'off',
  clickMode: 'gesture',
  gestureClickMs: 350,
  dwellEnabled: false,
  dwellMs: 2000,
  dwellStabilityPx: 60,
  cursorSensitivity: 1.0,
  cursorSmoothing: 1.5,
  cursorBeta: 0.007,
  scrollSpeed: 1.0,
  headSensitivity: 1.2,
  headNeutralZone: 0.03,
  activeFilter: 'none',
  showLandmarkOverlay: true,
  autoStartCamera: false,
};

const STORAGE_KEY = 'freehand-settings-v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage quota exceeded or private mode — ignore
  }
}

export function resetSettings(): AppSettings {
  localStorage.removeItem(STORAGE_KEY);
  return { ...DEFAULTS };
}
