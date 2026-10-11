// Which MathEngine this is, and a quiet notice when a newer release is out (once per launch).
// Release builds know their channel: stable builds look for newer stable releases, nightly builds for a
// newer nightly. Running from source never checks. The check can be turned off in Settings.

import { useEffect, useState } from 'react';
import { api, type AppInfo, type UpdateInfo } from '../api';
import { setState, toast, useStore } from '../store';

const CHECK_KEY = 'mathengine.checkUpdates';
const DISMISS_KEY = 'mathengine.dismissedUpdate';

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the setting just isn't remembered */
  }
}

export const checksForUpdates = () => stored(CHECK_KEY) !== 'off';
export const setChecksForUpdates = (on: boolean) => store(CHECK_KEY, on ? 'on' : 'off');

/** "0.2.0 (nightly abc1234)" */
export function versionLabel(info: AppInfo | null): string {
  if (!info) return '';
  if (info.channel === 'stable') return info.version;
  if (info.channel === 'nightly') return `${info.version} (nightly ${info.commit})`;
  return `${info.version} (from source)`;
}

export function openReleases(url: string) {
  api.openRelease(url).then((r) => !r.ok && toast(`Open ${url} in your browser`)).catch(() => toast(`Open ${url} in your browser`));
}

/** Toolbar notice: "Update available", shown when a newer release is out (until dismissed for that version). */
export function UpdateNotice() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    api.version().then((app) => setState({ app })).catch(() => undefined);
    if (!checksForUpdates()) return;
    const t = window.setTimeout(() => {
      api.updateCheck()
        .then((u) => u.available && u.latest !== stored(DISMISS_KEY) && setUpdate(u))
        .catch(() => undefined); // offline: no notice
    }, 3000); // after start-up work
    return () => clearTimeout(t);
  }, []);
  if (!update?.available) return null;
  return (
    <span className="update-pill" title={`You have ${versionLabel(update)}. Open the release page to download ${update.latest}.`}>
      <button className="ghost small" onClick={() => openReleases(update.url ?? update.releases)}>Update {update.latest}</button>
      <button className="x-btn" title="Hide until the next version" onClick={() => { store(DISMISS_KEY, update.latest ?? ''); setUpdate(null); }}>×</button>
    </span>
  );
}

/** Settings section: version, release page, and the update-check switch. */
export function AppSettings() {
  const app = useStore((s) => s.app);
  const [on, setOn] = useState(checksForUpdates());
  return (
    <section className="app-settings">
      <h4>App</h4>
      <p className="muted small">MathEngine {versionLabel(app)}{app && <> · <button className="link" onClick={() => openReleases(app.releases)}>releases</button></>}</p>
      {app?.channel !== 'dev' ? (
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setChecksForUpdates(e.target.checked); }} />
          Tell me when a new {app?.channel === 'nightly' ? 'nightly build' : 'version'} is out (checks GitHub once per launch)
        </label>
      ) : (
        <p className="muted small">Running from source: no update checks.</p>
      )}
    </section>
  );
}
