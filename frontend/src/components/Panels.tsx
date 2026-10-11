import { useEffect, useRef, useState } from 'react';
import { api, askPath } from '../api';
import {
  addMarker, commitTransform, copyClips, deleteSelection, docKey, previewFresh, renderPreview, duplicateObjects, editPoints, fps, frameSnap, getState, loadDoc, selectedObjectIds,
  pasteClips, redo, sequenceEnd, setPlaying, setState, toast, toggleDisabled, undo, updateDoc, useStore,
} from '../store';
import { zoomBy, zoomToFit } from './Timeline';
import type { Job } from '../types';
import { Field } from './ParamField';
import { Modal } from './Modal';
import { DeleteDialog, GraphBuilder, InsertConstruction, SaveConstruction } from './Dialogs';
import { HelpPanel } from './Help';
import { AppSettings, UpdateNotice } from './Updates';
import { NewProjectDialog } from './Home';

/** Project files: .manimstudio, and .mathengine from versions before the rename. */
const PROJECT_FILES = 'Manim Studio project (*.manimstudio;*.mathengine)';
const PYTHON_FILES = 'manim code (*.py)';
const PROJECT_EXT = /\.(manimstudio|mathengine)$/;

export async function saveProject(saveAs = false) {
  const s = getState();
  let path = s.path;
  const suggested = `${s.doc.scene.name.replace(/Scene$/, '') || 'scene'}.manimstudio`;
  if (!path || saveAs) path = await askPath('save', suggested, [PROJECT_FILES], 'Save project to path:');
  if (!path) return;
  if (!PROJECT_EXT.test(path)) path += '.manimstudio'; // projects from earlier versions keep their .mathengine name
  await api.saveProject(path, s.doc);
  setState({ path, dirty: false });
  toast(`Saved ${path}`);
}

/** Leave the current project (asks first when it has unsaved changes). */
export const discardOk = () => !getState().hasProject || !getState().dirty || confirm('Discard unsaved changes to the current project?');

export async function openPath(path: string) {
  if (!discardOk()) return;
  try {
    const res = await api.openProject(path);
    loadDoc(res.doc, res.path);
    if (res.imported) {
      setState({ centerTab: 'code', dirty: true });
      toast(`Opened ${res.imported.split(/[\\/]/).pop()} as a new project${res.notes?.length ? `. ${res.notes.length} statement${res.notes.length === 1 ? ' is' : 's are'} kept as code` : ''}`);
    }
  } catch (e) {
    toast(`Couldn't open ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

export async function openProject() {
  const path = await askPath('open', '', [PROJECT_FILES, PYTHON_FILES], 'Open project (or manim .py file) path:');
  if (path) await openPath(path);
}

/** Open a manim .py file as a new project: its code becomes the timeline. */
export async function importManimFile() {
  const path = await askPath('open', '', [PYTHON_FILES], 'manim .py file path:');
  if (path) await openPath(path);
}

export function Toolbar() {
  const path = useStore((s) => s.path);
  const dirty = useStore((s) => s.dirty);
  const snap = useStore((s) => s.snap);
  const record = useStore((s) => s.record);
  const autoIntro = useStore((s) => s.autoIntro);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const name = path ? path.split(/[\\/]/).pop() : 'Untitled';
  return (
    <header className="toolbar">
      <button className="brand" title="Home: projects and samples" onClick={() => setState({ home: true })}><img className="brand-icon" src="icon.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />Manim Studio</button>
      <button className="ghost home-btn" title="Home: new, recent and sample projects" onClick={() => setState({ home: true })}>⌂ Home</button>
      <span className="muted">{name}{dirty ? ' •' : ''}</span>
      <button className="ghost" title="New project (choose its format)" onClick={() => setState({ panel: 'new-project' })}>New</button>
      <button className="ghost" onClick={() => openProject().catch((e) => toast(String(e)))}>Open</button>
      <button className="ghost" onClick={() => saveProject().catch((e) => toast(String(e)))}>Save</button>
      <span className="sep" />
      <button className="ghost" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)">↶</button>
      <button className="ghost" disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)">↷</button>
      <span className="sep" />
      <label className="toggle" title="Snap positions to 0.25 units"><input type="checkbox" checked={snap} onChange={(e) => setState({ snap: e.target.checked })} /> Snap</label>
      <label className="toggle" title="New objects get a Create/Write step automatically"><input type="checkbox" checked={autoIntro} onChange={(e) => setState({ autoIntro: e.target.checked })} /> Auto-intro</label>
      <label data-tour="record" className={`toggle ${record ? 'rec' : ''}`} title="Canvas drags, resizes and rotations become .animate clips at the playhead instead of changing the starting state"><input type="checkbox" checked={record} onChange={(e) => setState({ record: e.target.checked })} /> ● Record</label>
      <div className="spacer" />
      <UpdateNotice />
      <button data-tour="graph" className="ghost" title="Graph a function from an expression, with parameter sliders" onClick={() => setState({ panel: 'graph', panelData: null })}>ƒ Graph</button>
      <span className="toolbar-group" data-tour="output">
        <PreviewButton />
        <CodeToggle />
        <button onClick={() => setState({ panel: 'settings' })}>Settings</button>
        <button className="primary" onClick={() => setState({ panel: 'export' })}>Export video</button>
      </span>
      <button data-tour="help" className="ghost help-btn" title="Guide and tour (? or F1)" onClick={() => setState({ panel: 'help', panelData: null })}>? Help</button>
    </header>
  );
}

/** Switch the center panel between the canvas and the code (they show the same scene). */
function CodeToggle() {
  const tab = useStore((s) => s.centerTab);
  return (
    <button className={tab === 'code' ? 'on' : ''} title="The scene as manim code: edit it, or paste a manim file, and the timeline follows" onClick={() => setState({ centerTab: tab === 'code' ? 'program' : 'code' })}>
      &lt;/&gt; Code
    </button>
  );
}

/** Status of the background preview render (Premiere's render bar, as a button). */
function PreviewButton() {
  const video = useStore((s) => s.video);
  const fresh = useStore((s) => previewFresh(s));
  const autoRender = useStore((s) => s.autoRender);
  const running = video && (video.state === 'running' || video.state === 'queued') && !fresh;
  const stale = !fresh && !running;
  return (
    <>
      <label className="toggle" title="Render a smooth preview with manim in the background after each edit; Space plays it">
        <input type="checkbox" checked={autoRender} onChange={(e) => { setState({ autoRender: e.target.checked }); if (e.target.checked) void renderPreview(); }} /> Auto-render
      </label>
      <button
        className={`render-status ${fresh ? 'ok' : running ? 'busy' : 'stale'}`}
        title={fresh ? 'Smooth preview is up to date: Space plays it' : running ? video?.message : video?.state === 'error' ? video.message : 'Render a smooth preview now'}
        onClick={() => (fresh ? (setState({ time: getState().time >= sequenceEnd(getState().doc, getState().timeline) - 1e-3 ? 0 : getState().time }), setPlaying(true)) : stale && renderPreview())}
      >
        {fresh ? '● Preview ready' : running ? `Rendering ${Math.round((video?.progress ?? 0) * 100)}%` : video?.state === 'error' && video.key === docKey(getState().doc) ? '● Render failed' : '● Render preview'}
      </button>
    </>
  );
}

function poll(id: string, onUpdate: (j: Job) => boolean) {
  const tick = async () => {
    try {
      const j = await api.job(id);
      if (onUpdate(j)) setTimeout(tick, 400);
    } catch (e) {
      toast(String(e));
    }
  };
  setTimeout(tick, 300);
}

export function Panels() {
  const panel = useStore((s) => s.panel);
  if (panel === 'settings') return <SettingsPanel />;
  if (panel === 'export') return <ExportPanel />;
  if (panel === 'graph') return <GraphBuilder />;
  if (panel === 'help') return <HelpPanel />;
  if (panel === 'delete') return <DeleteDialog />;
  if (panel === 'insert') return <InsertConstruction />;
  if (panel === 'save-construction') return <SaveConstruction />;
  if (panel === 'new-project') return <NewProjectDialog />;
  return null;
}

export const RESOLUTIONS: [string, number, number][] = [['480p', 854, 480], ['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4K', 3840, 2160], ['1080×1920 (vertical)', 1080, 1920], ['1080×1080 (square)', 1080, 1080]];

function SettingsPanel() {
  const doc = useStore((s) => s.doc);
  const bases = useStore((s) => s.catalog?.scene_bases ?? ['Scene']);
  const set = (fn: (d: typeof doc) => void, key: string) => updateDoc(fn, 'settings:' + key);
  const res = `${doc.config.pixel_width}x${doc.config.pixel_height}`;
  return (
    <Modal title="Scene settings">
      <label className="param"><span className="pname">Class name</span><Field className="mono" value={doc.scene.name} onChange={(v) => /^[A-Za-z_]\w*$/.test(v) && set((d) => void (d.scene.name = v), 'name')} /></label>
      <label className="param">
        <span className="pname">Base class</span>
        <Field className="mono" value={doc.scene.base} list="me-bases" onChange={(v) => set((d) => void (d.scene.base = v), 'base')} />
        <datalist id="me-bases">{bases.map((b) => <option key={b} value={b} />)}</datalist>
      </label>
      <label className="param">
        <span className="pname">Resolution</span>
        <select className="field" value={res} onChange={(e) => {
          const [w, h] = e.target.value.split('x').map(Number);
          set((d) => { d.config.pixel_width = w; d.config.pixel_height = h; }, 'res');
        }}>
          {RESOLUTIONS.map(([n, w, h]) => <option key={n} value={`${w}x${h}`}>{n}</option>)}
          {!RESOLUTIONS.some(([, w, h]) => `${w}x${h}` === res) && <option value={res}>{res}</option>}
        </select>
      </label>
      <label className="param">
        <span className="pname">Frame rate</span>
        <select className="field" value={doc.config.frame_rate} onChange={(e) => set((d) => void (d.config.frame_rate = +e.target.value), 'fps')}>
          {[24, 30, 60, 120].map((f) => <option key={f} value={f}>{f} fps</option>)}
        </select>
      </label>
      <label className="param">
        <span className="pname">Background</span>
        <div className="row">
          <input type="color" className="swatch" value={doc.config.background_color} onChange={(e) => set((d) => void (d.config.background_color = e.target.value), 'bg')} />
          <Field className="mono" value={doc.config.background_color} onChange={(v) => /^#[0-9a-f]{6}$/i.test(v) && set((d) => void (d.config.background_color = v), 'bg')} />
        </div>
      </label>
      <AppSettings />
    </Modal>
  );
}

function ExportPanel() {
  const doc = useStore((s) => s.doc);
  const path = useStore((s) => s.path);
  const [quality, setQuality] = useState('project');
  const [output, setOutput] = useState(() => (path ? path.replace(PROJECT_EXT, '.mp4') : ''));
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<string | null>(null);
  useEffect(() => () => { jobRef.current = null; }, []);

  const start = async () => {
    let out = output;
    if (!out) {
      out = (await askPath('save', 'scene.mp4', ['MP4 video (*.mp4)'], 'Save video to path:')) ?? '';
      if (!out) return;
      setOutput(out);
    }
    const j = await api.render(doc, quality, out);
    setJob(j);
    if (!j.id || j.state === 'error') return;
    jobRef.current = j.id;
    poll(j.id, (u) => {
      if (jobRef.current !== j.id) return false;
      setJob(u);
      return u.state === 'running' || u.state === 'queued';
    });
  };
  const running = job && (job.state === 'running' || job.state === 'queued');
  return (
    <Modal title="Export video">
      <label className="param">
        <span className="pname">Quality</span>
        <select className="field" value={quality} onChange={(e) => setQuality(e.target.value)}>
          <option value="project">Project ({doc.config.pixel_width}×{doc.config.pixel_height} @ {doc.config.frame_rate}fps)</option>
          <option value="720p">720p30</option>
          <option value="1080p">1080p60</option>
          <option value="1440p">1440p60</option>
          <option value="4k">4K60</option>
        </select>
      </label>
      <label className="param">
        <span className="pname">Output</span>
        <div className="row">
          <Field className="mono" value={output} placeholder="choose a file…" onChange={setOutput} />
          <button className="ghost" onClick={async () => { const p = await askPath('save', 'scene.mp4', ['MP4 video (*.mp4)'], 'Save video to path:'); if (p) setOutput(p); }}>Browse</button>
        </div>
      </label>
      {job && (
        <div className="export-status">
          <div className="progress"><div style={{ width: `${(job.progress ?? 0) * 100}%` }} /></div>
          <div className={job.state === 'error' ? 'err-text' : 'muted'}>{job.message}</div>
          {job.state === 'error' && job.log && <pre className="code-view small">{job.log}</pre>}
        </div>
      )}
      <div className="row actions">
        {running ? (
          <button className="danger" onClick={() => job?.id && api.cancelJob(job.id).then(setJob)}>Cancel</button>
        ) : (
          <button className="primary" onClick={() => start().catch((e) => toast(String(e)))}>Render with manim</button>
        )}
      </div>
    </Modal>
  );
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (getState().home) {
        // Home screen: only the project shortcuts (the editor behind it isn't shown).
        if (mod && (k === 'o' || k === 'n')) {
          e.preventDefault();
          if (k === 'o') void openProject().catch((err) => toast(String(err)));
          else setState({ panel: 'new-project' });
        } else if (e.key === 'F1') setState({ panel: 'help', panelData: null });
        return;
      }
      if (mod && k === 's') {
        e.preventDefault();
        void saveProject(e.shiftKey).catch((err) => toast(String(err)));
        return;
      }
      if (mod && k === 'o') {
        e.preventDefault();
        void openProject().catch((err) => toast(String(err)));
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setState({ panel: 'help', panelData: null });
        return;
      }
      if (typing) return;
      const s = getState();
      if (e.key === '?' && !mod) {
        e.preventDefault();
        setState({ panel: s.panel === 'help' ? null : 'help', panelData: null });
        return;
      }
      const go = (t: number) => setState({ time: frameSnap(Math.max(0, Math.min(sequenceEnd(s.doc, s.timeline), t))), showVideo: false });
      const objSel = s.selection?.kind === 'object' ? s.selection.id : null;
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') redo();
      else if (mod && k === 'c') copyClips();
      else if (mod && k === 'v') pasteClips();
      else if (mod && k === 'd') {
        e.preventDefault();
        if (selectedObjectIds().length) duplicateObjects(selectedObjectIds());
      } else if (e.key === ' ' || k === 'l') {
        e.preventDefault();
        setPlaying(e.key === ' ' ? !s.playing : true);
      } else if (k === 'k') setPlaying(false);
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection(e.shiftKey);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(sequenceEnd(s.doc, s.timeline));
      else if (objSel && e.key.startsWith('Arrow')) {
        // Nudge the selected object on the canvas (Shift = 1 unit).
        e.preventDefault();
        const step = e.shiftKey ? 1 : 0.1;
        const d: [number, number] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] as [number, number];
        const info = s.frame?.objects.find((o) => o.id === objSel);
        commitTransform(objSel, { move: d }, info?.center ?? null);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const n = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        go(s.time + n / fps());
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const pts = editPoints(s.doc, s.timeline);
        const t = e.key === 'ArrowDown' ? pts.find((p) => p > s.time + 1e-6) : [...pts].reverse().find((p) => p < s.time - 1e-6);
        if (t !== undefined) go(t);
      } else if (k === 'm') addMarker();
      else if (k === 's' && !mod) setState({ timelineSnap: !s.timelineSnap });
      else if (e.key === '=' || e.key === '+') zoomBy(1.4);
      else if (e.key === '-') zoomBy(1 / 1.4);
      else if (e.key === '\\') zoomToFit(document.querySelector('.tl-lanes')?.clientWidth);
      else if (e.shiftKey && k === 'e' && s.selection?.kind === 'clips') toggleDisabled(s.selection.ids);
      else if (e.key === 'Escape') setState({ selection: null, panel: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
