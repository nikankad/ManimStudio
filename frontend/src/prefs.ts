import { api } from './api';

// Small settings (the update check, the welcome card, the timeline's height) live with the backend, in the app
// folder: the editor's address changes at every launch, so the window's own storage starts empty each time.

let cache: Record<string, string> = {};

/** Fetch the saved preferences; call once before the editor renders. Without them everything is at its default. */
export async function loadPrefs(): Promise<void> {
  try {
    cache = (await api.prefs()).prefs;
  } catch {
    cache = {};
  }
}

export const pref = (key: string): string | null => cache[key] ?? null;

export function setPref(key: string, value: string | null) {
  if (value === null) delete cache[key];
  else cache[key] = value;
  api.setPref(key, value).catch(() => undefined); // not remembered next time, but this session carries on
}
