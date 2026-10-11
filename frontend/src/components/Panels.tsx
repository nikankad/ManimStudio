import { useEffect, useRef, useState } from 'react';
import { api, askPath } from '../api';
import {
  addMarker, nudgeObjects, copyClips, deleteSelection, docKey, previewFresh, renderPreview, duplicateClips, duplicateObjects, editPoints, emptyDoc, fps, frameSnap, getState, loadDoc, selectClips, selectObjects, selectedObjectIds,
  pasteClips, redo, sequenceEnd, setPlaying, setState, toast, undo, updateDoc, useStore,
} from '../store';
import { zoomBy, zoomToFit } from './Timeline';
import { isTextEntry, matchShortcut, shortcutHint, viewerCommand } from '../shortcuts';
import type { Job, Tool } from '../types';
import { Field } from './ParamField';
import { Modal } from './Modal';
import { DeleteDialog, GraphBuilder, InsertConstruction, SaveConstruction } from './Dialogs';
import { HelpPanel } from './Help';
import { AppSettings, UpdateNotice } from './Updates';

/** Project files: .manimstudio, and .mathengine from versions before the rename. */
const PROJECT_FILES = 'Manim Studio project (*.manimstudio;*.mathengine)';
const PROJECT_EXT = /\.(manimstudio|mathengine)$/;

export async function saveProject(saveAs = false) {
  const s = getState();
  let path = s.path;
  if (!path || saveAs) path = await askPath('save', 'scene.manimstudio', [PROJECT_FILES], 'Save project to path:');
  if (!path) return;
  if (!PROJECT_EXT.test(path)) path += '.manimstudio'; // projects from earlier versions keep their .mathengine name
  await api.saveProject(path, s.doc);
  setState({ path, dirty: false });
  toast(`Saved ${path}`);
}

export function newProject() {
  if (!getState().dirty || confirm('Discard unsaved changes?')) loadDoc(emptyDoc(), null);
}

export async function openProject() {
  const path = await askPath('open', '', [PROJECT_FILES], 'Open project path:');
  if (!path) return;
  if (getState().dirty && !confirm('Discard unsaved changes?')) return;
  const res = await api.openProject(path);
  loadDoc(res.doc, res.path);
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
      <span className="brand"><img className="brand-icon" src="icon.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />Manim Studio</span>
      <span className="muted">{name}{dirty ? ' •' : ''}</span>
      <button className="ghost" title={shortcutHint('new')} onClick={newProject}>New</button>
      <button className="ghost" title={shortcutHint('open')} onClick={() => openProject().catch((e) => toast(String(e)))}>Open</button>
      <button className="ghost" title={shortcutHint('save')} onClick={() => saveProject().catch((e) => toast(String(e)))}>Save</button>
      <span className="sep" />
      <button className="ghost" disabled={!canUndo} onClick={undo} title={shortcutHint('undo')}>↶</button>
      <button className="ghost" disabled={!canRedo} onClick={redo} title={shortcutHint('redo')}>↷</button>
      <span className="sep" />
      <label className="toggle" title={shortcutHint('canvas-snap')}><input type="checkbox" checked={snap} onChange={(e) => setState({ snap: e.target.checked })} /> Snap</label>
      <label className="toggle" title="New objects get a Create/Write step automatically"><input type="checkbox" checked={autoIntro} onChange={(e) => setState({ autoIntro: e.target.checked })} /> Auto-intro</label>
      <label data-tour="record" className={`toggle ${record ? 'rec' : ''}`} title={shortcutHint('record')}><input type="checkbox" checked={record} onChange={(e) => setState({ record: e.target.checked })} /> ● Record</label>
      <div className="spacer" />
      <UpdateNotice />
      <button data-tour="graph" className="ghost" title={shortcutHint('graph')} onClick={() => setState({ panel: 'graph', panelData: null })}>ƒ Graph</button>
      <span className="toolbar-group" data-tour="output">
        <PreviewButton />
        <button title={shortcutHint('code')} onClick={() => setState({ panel: 'code' })}>&lt;/&gt; Code</button>
        <button title={shortcutHint('settings')} onClick={() => setState({ panel: 'settings' })}>Settings</button>
        <button className="primary" title={shortcutHint('export')} onClick={() => setState({ panel: 'export' })}>Export video</button>
      </span>
      <button data-tour="help" className="ghost help-btn" title="Guide and tour (? or F1)" onClick={() => setState({ panel: 'help', panelData: null })}>? Help</button>
    </header>
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
  if (panel === 'code') return <CodePanel />;
  if (panel === 'settings') return <SettingsPanel />;
  if (panel === 'export') return <ExportPanel />;
  if (panel === 'graph') return <GraphBuilder />;
  if (panel === 'help') return <HelpPanel />;
  if (panel === 'delete') return <DeleteDialog />;
  if (panel === 'insert') return <InsertConstruction />;
  if (panel === 'save-construction') return <SaveConstruction />;
  return null;
}

function CodePanel() {
  const doc = useStore((s) => s.doc);
  const [code, setCode] = useState('');
  useEffect(() => {
    api.code(doc).then((r) => setCode(r.code)).catch((e) => toast(String(e)));
  }, [doc]);
  return (
    <Modal title="Code" wide>
      <div className="code-grid">
        <div>
          <h4>Header (module level)</h4>
          <p className="muted small">Imports, helper functions and custom Mobject subclasses. Classes defined here show up in the library.</p>
          <Field multiline className="mono code-input tall" value={doc.header} placeholder={'from manim_slides import Slide\n\nclass Pendulum(VGroup):\n    ...'} onChange={(v) => updateDoc((d) => void (d.header = v), 'header')} />
        </div>
        <div>
          <h4>
            Generated manim code{' '}
            <button className="ghost small" onClick={() => navigator.clipboard.writeText(code).then(() => toast('Copied'))}>Copy</button>
            <button className="ghost small" onClick={async () => {
              const p = await askPath('save', 'scene.py', ['Python (*.py)'], 'Save .py to path:');
              if (p) toast(`Saved ${(await api.exportCode(getState().doc, p)).path}`);
            }}>Save .py</button>
          </h4>
          <pre className="code-view">{code}</pre>
          <p className="muted small">Run it directly with <code>manim -pqh scene.py {doc.scene.name}</code></p>
        </div>
      </div>
    </Modal>
  );
}

const RESOLUTIONS: [string, number, number][] = [['480p', 854, 480], ['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4K', 3840, 2160], ['1080×1920 (vertical)', 1080, 1920], ['1080×1080 (square)', 1080, 1080]];

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
      if (e.defaultPrevented || e.isComposing || e.altKey && e.ctrlKey) return;
      const s = getState();
      if (s.tour !== null) return;
      // Dialogs own the keyboard, including drawing keys and editor actions.
      if (e.key === 'Escape' && !e.repeat) {
        e.preventDefault();
        if (s.panel) setState({ panel: null, panelData: null });
        else if (isTextEntry(e)) (document.querySelector('.monitor') as HTMLElement | null)?.focus();
        else if (s.viewerMaximized) setState({ viewerMaximized: false });
        else setState({ selection: null });
        return;
      }
      if (s.panel) return;
      const binding = matchShortcut(e);
      if (!binding || isTextEntry(e) && !binding.whileTyping) return;
      // Let focused buttons keep native Space/Enter activation.
      if (e.key === ' ' && e.composedPath().some((n) => n instanceof Element && n.matches('button, [role="button"]'))) return;
      const id = binding.id;
      const focused = document.activeElement;
      const inTimeline = focused instanceof Element && Boolean(focused.closest('.timeline'));
      const inViewer = focused instanceof Element && Boolean(focused.closest('.monitor'));
      const objects = selectedObjectIds();
      const timelineContext = inTimeline || !inViewer && s.selection?.kind === 'clips';
      if (id === 'copy' && s.selection?.kind !== 'clips') return;
      e.preventDefault();
      const go = (t: number) => {
        setPlaying(false);
        setState({ time: frameSnap(Math.max(0, Math.min(sequenceEnd(s.doc, s.timeline), t))), showVideo: false });
      };
      if (id.startsWith('tool-')) {
        setState({ tool: id.slice(5) as Tool });
        (document.querySelector('.monitor') as HTMLElement | null)?.focus();
        return;
      }
      if (id.startsWith('focus-')) {
        const selectors: Record<string, string> = { viewer: '.monitor', inspector: '.inspector .scroll', timeline: '.timeline' };
        if (id !== 'focus-viewer') setState({ viewerMaximized: false });
        if (id === 'focus-library') window.dispatchEvent(new Event('library-search'));
        else (document.querySelector(selectors[id.slice(6)]) as HTMLElement | null)?.focus();
        return;
      }
      switch (id) {
        case 'new': newProject(); break;
        case 'open': void openProject().catch((err) => toast(String(err))); break;
        case 'save': case 'save-as': void saveProject(id === 'save-as').catch((err) => toast(String(err))); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'copy': copyClips(); break;
        case 'paste': pasteClips(); break;
        case 'duplicate': if (s.selection?.kind === 'clips') duplicateClips(); else duplicateObjects(objects); break;
        case 'select-all':
          if (timelineContext) selectClips(s.doc.clips.filter((c) => !s.doc.tracks.find((t) => t.id === c.track)?.locked).map((c) => c.id));
          else selectObjects(inViewer && s.frame ? s.frame.objects.filter((o) => o.visible && o.box).map((o) => o.id) : s.doc.objects.map((o) => o.id));
          break;
        case 'delete': case 'ripple-delete': deleteSelection(id === 'ripple-delete'); break;
        case 'toggle-play': setPlaying(!s.playing); break;
        case 'play': setPlaying(true); break;
        case 'pause': setPlaying(false); break;
        case 'back': go(s.time - 5 / fps()); break;
        case 'start': go(0); break;
        case 'end': go(sequenceEnd(s.doc, s.timeline)); break;
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          if (objects.length && !inTimeline) {
            const step = e.shiftKey ? 1 : s.snap ? 0.25 : 0.1;
            const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
            nudgeObjects(objects, moves[id]);
          } else if (id === 'ArrowLeft' || id === 'ArrowRight') go(s.time + (e.shiftKey ? 5 : 1) * (id === 'ArrowLeft' ? -1 : 1) / fps());
          else {
            const pts = editPoints(s.doc, s.timeline);
            const t = id === 'ArrowDown' ? pts.find((p) => p > s.time + 1e-6) : [...pts].reverse().find((p) => p < s.time - 1e-6);
            if (t !== undefined) go(t);
          }
          break;
        }
        case 'marker': addMarker(); break;
        case 'snap': setState({ timelineSnap: !s.timelineSnap }); break;
        case 'canvas-snap': setState({ snap: !s.snap }); break;
        case 'record': setState({ record: !s.record }); break;
        case 'zoom-in': case 'zoom-out':
          if (inViewer || s.viewerMaximized) viewerCommand(id);
          else zoomBy(id === 'zoom-in' ? 1.4 : 1 / 1.4);
          break;
        case 'fit':
          if (inViewer || s.viewerMaximized) viewerCommand('fit');
          else zoomToFit(document.querySelector('.tl-lanes')?.clientWidth);
          break;
        case 'viewer-fit': viewerCommand('fit'); break;
        case 'viewer-selection': viewerCommand('selection'); break;
        case 'viewer-maximize': setState({ viewerMaximized: !s.viewerMaximized }); break;
        case 'enable': {
          if (s.selection?.kind !== 'clips') break;
          const ids = new Set(s.selection.ids);
          updateDoc((d) => d.clips.filter((c) => ids.has(c.id) && !d.tracks.find((t) => t.id === c.track)?.locked).forEach((c) => (c.disabled = !c.disabled)));
          break;
        }
        case 'help': setState({ panel: 'help', panelData: 'keys' }); break;
        case 'graph': case 'code': case 'settings': case 'export': setState({ panel: id, panelData: null }); break;
        case 'preview': void renderPreview(); break;
        case 'search': setState({ viewerMaximized: false }); window.dispatchEvent(new Event('library-search')); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
