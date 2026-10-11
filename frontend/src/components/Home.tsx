// The Home screen: start a project, open a recent one, or start from a sample. Shown at launch (unless a
// project file was given) and from the toolbar's Manim Studio button.

import { useEffect, useMemo, useState } from 'react';
import { api, type RecentProject, type Sample } from '../api';
import { emptyDoc, frameSnap, getState, loadDoc, setState, toast, useStore } from '../store';
import { Field } from './ParamField';
import { Modal } from './Modal';
import { discardOk, openPath, openProject, RESOLUTIONS } from './Panels';
import { openReleases, versionLabel } from './Updates';

type Section = 'home' | 'learn';

function ago(seconds: number | null): string {
  if (!seconds) return '';
  const d = Date.now() / 1000 - seconds;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 2 * 86400) return 'yesterday';
  if (d < 30 * 86400) return `${Math.floor(d / 86400)} days ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function size(bytes: number | null): string {
  if (bytes === null) return '';
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const seconds = (s: number) => `0:${String(Math.round(s)).padStart(2, '0')}`;

async function openSample(s: Sample) {
  if (!discardOk()) return;
  try {
    const res = await api.openSample(s.id);
    loadDoc(res.doc, null);
    setState({ time: frameSnap(s.duration * 0.7) }); // the frame on its card
    toast(`${s.name}: a copy of the sample. Press ⏮ then Play to watch it from the start; Save keeps your own copy.`);
  } catch (e) {
    toast(String(e));
  }
}

export function Home() {
  const app = useStore((s) => s.app);
  const hasProject = useStore((s) => s.hasProject);
  const path = useStore((s) => s.path);
  const [section, setSection] = useState<Section>('home');
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.home().then((h) => { setRecent(h.recent); setSamples(h.samples); }).catch((e) => { setRecent([]); toast(String(e)); });
    if (!getState().app) api.version().then((a) => setState({ app: a })).catch(() => undefined);
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (recent ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q));
  }, [recent, filter]);

  const remove = (r: RecentProject) => api.removeRecent(r.path).then((h) => setRecent(h.recent)).catch((e) => toast(String(e)));
  const current = hasProject ? (path ? path.split(/[\\/]/).pop() : 'Untitled') : null;

  return (
    <div className="home">
      <header className="home-top">
        <img className="home-logo" src="icon.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
        <span className="home-title">Manim Studio</span>
        <span className="spacer" />
        {current && <button className="ghost" title="Back to the project you have open" onClick={() => setState({ home: false })}>← Back to {current}</button>}
        <button className="ghost" onClick={() => setState({ panel: 'help', panelData: null })}>? Help</button>
      </header>
      <div className="home-body">
        <nav className="home-nav">
          <button className={`home-link ${section === 'home' ? 'on' : ''}`} onClick={() => setSection('home')}>Home</button>
          <button className={`home-link ${section === 'learn' ? 'on' : ''}`} onClick={() => setSection('learn')}>Learn</button>
          <div className="home-actions">
            <button className="primary home-cta" onClick={() => setState({ panel: 'new-project' })}>New project…</button>
            <button className="home-cta" onClick={() => void openProject()}>Open project…</button>
          </div>
          <span className="spacer" />
          <button className="home-link small" title="Release notes and downloads" onClick={() => app && openReleases(app.releases)}>What’s new</button>
          <span className="muted small home-version">{versionLabel(app)}</span>
        </nav>
        <main className="home-main">
          {section === 'home' ? (
            <>
              <section>
                <h2>Start from a sample</h2>
                <div className="sample-grid">
                  {samples.map((s) => (
                    <button key={s.id} className="sample-card" title={s.description} onClick={() => void openSample(s)}>
                      <div className="sample-thumb">
                        {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="muted">no preview</span>}
                        <span className="sample-length">{seconds(s.duration)}</span>
                      </div>
                      <b>{s.name}</b>
                      <span className="muted small">{s.description}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <div className="recent-head">
                  <h2>Recent</h2>
                  <span className="spacer" />
                  <input className="field recent-filter" placeholder="Filter recent projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
                {recent === null ? <p className="muted">Loading…</p> : recent.length === 0 ? (
                  <div className="recent-empty">
                    <p>No recent projects yet.</p>
                    <p className="muted small">Projects you open or save show up here. Start with <b>New project…</b>, or open a sample above.</p>
                  </div>
                ) : (
                  <table className="recent-table">
                    <thead>
                      <tr><th /><th>Name</th><th>Opened</th><th>Size</th><th>Location</th><th /></tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.path} className={r.exists ? '' : 'missing'} title={r.exists ? r.path : `${r.path}: moved or deleted`}
                          onClick={() => (r.exists ? void openPath(r.path) : toast('That file was moved or deleted'))}>
                          <td className="recent-thumb">{r.thumbnail ? <img src={r.thumbnail} alt="" /> : <span />}</td>
                          <td className="recent-name">{r.name}{!r.exists && <span className="muted small"> · missing</span>}</td>
                          <td className="muted">{ago(r.opened)}</td>
                          <td className="muted">{size(r.size)}</td>
                          <td className="muted recent-folder">{r.folder}</td>
                          <td><button className="x-btn" title="Remove from this list (the file stays)" onClick={(e) => { e.stopPropagation(); void remove(r); }}>×</button></td>
                        </tr>
                      ))}
                      {shown.length === 0 && <tr><td /><td colSpan={5} className="muted">No project matches “{filter}”.</td></tr>}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          ) : (
            <Learn />
          )}
        </main>
      </div>
    </div>
  );
}

function Learn() {
  const tour = () => {
    if (!getState().hasProject) loadDoc(emptyDoc(), null);
    setState({ home: false, tour: 0 });
  };
  return (
    <section>
      <h2>Learn</h2>
      <div className="learn-grid">
        <button className="learn-card" onClick={tour}>
          <b>Take the tour</b>
          <span className="muted small">One minute: where the canvas, library, inspector and timeline are, and how they fit together.</span>
        </button>
        <button className="learn-card" onClick={() => setState({ panel: 'help', panelData: null })}>
          <b>Read the guide</b>
          <span className="muted small">Drawing, connecting objects, parameters, the timeline, exporting video and code, and shortcuts.</span>
        </button>
        <button className="learn-card" onClick={() => setState({ panel: 'new-project' })}>
          <b>Start from scratch</b>
          <span className="muted small">Choose a format, then draw with the tools above the canvas or drag objects in from the library.</span>
        </button>
      </div>
      <p className="muted small">The samples on Home are ordinary projects: open one and select anything to see how it is built.</p>
    </section>
  );
}

const toClassName = (name: string) => {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  const cls = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z_]/.test(cls) ? cls : `Scene${cls}`;
};

/** New project: a name and the video format (resolution, frame rate, background). */
export function NewProjectDialog() {
  const [name, setName] = useState('My scene');
  const [res, setRes] = useState('1920x1080');
  const [fps, setFps] = useState(60);
  const [bg, setBg] = useState('#000000');
  const [w, h] = res.split('x').map(Number);
  const create = () => {
    if (!discardOk()) return;
    const doc = emptyDoc();
    doc.scene.name = toClassName(name) || 'MainScene';
    doc.config = { ...doc.config, pixel_width: w, pixel_height: h, frame_rate: fps, background_color: bg };
    loadDoc(doc, null);
    setState({ panel: null, panelData: null });
  };
  const scale = 120 / Math.max(w, h);
  return (
    <Modal title="New project">
      <div className="new-project">
        <div className="new-fields">
          <label className="param"><span className="pname">Name</span>
            <Field value={name} onChange={setName} placeholder="My scene" />
          </label>
          <p className="muted small new-hint">The scene class will be <code>{toClassName(name) || 'MainScene'}</code>. You choose where to save on the first Save.</p>
          <label className="param"><span className="pname">Format</span>
            <select className="field" value={res} onChange={(e) => setRes(e.target.value)}>
              {RESOLUTIONS.map(([n, rw, rh]) => <option key={n} value={`${rw}x${rh}`}>{n} · {rw}×{rh}</option>)}
            </select>
          </label>
          <label className="param"><span className="pname">Frame rate</span>
            <select className="field" value={fps} onChange={(e) => setFps(+e.target.value)}>
              {[24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
            </select>
          </label>
          <label className="param"><span className="pname">Background</span>
            <div className="row">
              {['#000000', '#1e1e1e', '#ffffff'].map((c) => <button key={c} className={`bg-swatch ${bg === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setBg(c)} />)}
              <input type="color" className="swatch" value={bg} onChange={(e) => setBg(e.target.value)} title="Another color" />
            </div>
          </label>
        </div>
        <div className="new-preview">
          <div className="new-frame" style={{ width: w * scale, height: h * scale, background: bg }} />
          <span className="muted small">{w}×{h} · {fps} fps</span>
        </div>
      </div>
      <div className="row actions">
        <span className="spacer" />
        <button onClick={() => setState({ panel: null, panelData: null })}>Cancel</button>
        <button className="primary" onClick={create}>Create</button>
      </div>
    </Modal>
  );
}
