/**
 * Browser-local UI state. These are view preferences, not show content, so
 * they live outside the project file and survive a reload.
 */
export const STORAGE_KEYS = {
  userColors: 'dmxsim.recentColors',
  timelineMode: 'dmxsim.timelineMode',
  render: 'dmxsim.render',
  volume: 'dmxsim.volume',
  stats: 'dmxsim.stats',
  dockHeight: 'dmxsim.dockHeight',
  dockCollapsed: 'dmxsim.dockCollapsed',
  waveHeight: 'dmxsim.waveHeight',
  panelWidth: 'dmxsim.sidePanelWidth',
  followPlayhead: 'dmxsim.followPlayhead',
  photosensitivity: 'dmxsim.photosensitivity',
} as const;

/** `localStorage` throws in private mode or when the quota is exhausted. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / quota: preferences are best-effort.
  }
}

/** Parsed number preference, or `NaN` when absent or malformed. */
export function readNumberPreference(key: string): number {
  return Number.parseFloat(readPreference(key) ?? '');
}
