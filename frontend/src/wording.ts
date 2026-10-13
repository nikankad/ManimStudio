// The user's wording for timeline clips (Change wording…), kept with the other preferences.

import { pref, setPref } from './prefs';
import { getState, setState } from './store';
import { getOverrides, setOverrides, type Overrides, type Section } from './words';

const KEY = 'ui.phrases';
const CODE_KEY = 'ui.clipCode'; // "1": clips show the code's names instead of words

/** Read the saved wording; call once the preferences are loaded. */
export function loadWording() {
  try {
    setOverrides(JSON.parse(pref(KEY) ?? '{}') as Overrides);
  } catch {
    setOverrides({});
  }
}

const changed = () => setState({ wording: getState().wording + 1 });

/** Change how one entry reads (null: back to the default). */
export function setPhrase(section: Section, key: string, template: string | null) {
  const o: Overrides = structuredClone(getOverrides());
  const sec = (o[section] ??= {});
  if (template === null) delete sec[key];
  else sec[key] = template;
  if (!Object.keys(sec).length) delete o[section];
  setOverrides(o);
  setPref(KEY, Object.keys(o).length ? JSON.stringify(o) : null);
  changed();
}

export function resetWording() {
  setOverrides({});
  setPref(KEY, null);
  changed();
}

export const customCount = () => Object.values(getOverrides()).reduce((n, s) => n + Object.keys(s ?? {}).length, 0);

export const clipsInWords = () => pref(CODE_KEY) !== '1';
export function setClipsInWords(on: boolean) {
  setPref(CODE_KEY, on ? null : '1');
  changed();
}
