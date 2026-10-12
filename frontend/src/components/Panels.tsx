import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, askPath } from '../api';
import {
  addMarker, commitTransform, copyClips, cutClips, deleteSelection, docKey, previewFresh, renderPreview, duplicateObjects, editPoints, fps, frameSnap, getState, loadDoc, selectedObjectIds,
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
import { keys } from '../keys';

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

/** Leave the current project: when it has unsaved changes, asks to save them, drop them or stay. Resolves false to stay. */
export async function discardOk(): Promise<boolean> {
  if (!getState().hasProject || !getState().dirty) return true;
  const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => setState({ leave: { resolve } }));
  setState({ leave: null });
  if (choice !== 'save') return choice === 'discard';
  try {
    await saveProject();
  } catch (e) {
    toast(`Couldn't save: ${e instanceof Error ? e.message : e}`);
  }
  return !getState().dirty; // still unsaved: the save was cancelled or failed, so stay
}

function LeaveDialog() {
  const leave = useStore((s) => s.leave);
  const path = useStore((s) => s.path);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!leave) return;
    // Focus the dialog, not a button: this question often opens on an Enter keypress (Create in New project), and
    // that same keypress would otherwise press the focused Save button before anyone has read the question.
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leave.resolve('cancel');
      else if (e.key === 'Enter') leave.resolve('save');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [leave]);
  if (!leave) return null;
  const name = path ? path.split(/[\\/]/).pop() : 'Untitled';
  return (
    <div className="modal-back leave-back" onPointerDown={(e) => e.target === e.currentTarget && leave.resolve('cancel')}>
      <div className="modal" role="alertdialog" aria-label="Unsaved changes" tabIndex={-1} ref={box}>
        <div className="modal-head"><h3>Save changes to {name}?</h3></div>
        <p className="muted">Your changes will be lost if you don’t save them.</p>
        <div className="row actions">
          <button onClick={() => leave.resolve('discard')}>Don’t save</button>
          <span className="spacer" />
          <button onClick={() => leave.resolve('cancel')}>Cancel</button>
          <button className="primary" onClick={() => leave.resolve('save')}>Save</button>
        </div>
      </div>
    </div>
  );
}

export async function openPath(path: string) {
  if (!(await discardOk())) return;
  try {
    const res = await api.openProject(path);
    loadDoc(res.doc, res.path);
    if (res.recovery?.length) setState({ restore: res.recovery[0] });
    if (res.imported) {
      setState({ centerTab: 'code', dirty: true });
      toast(`Opened ${res.imported.split(/[\\/]/).pop()} as a new project${res.notes?.length ? `. ${res.notes.length} statement${res.notes.length === 1 ? ' is' : 's are'} kept as code` : ''}`);
    }
  } catch (e) {
    toast(`Couldn’t open it: ${e instanceof Error ? e.message : e}`);
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

/**
 * Whether the toolbar has run out of room, so its toggles go into a menu. It folds when its content overflows and
 * unfolds once the window is as wide as the full toolbar was: that depends on the project's name and the update
 * notice as much as on the window, so it is measured rather than assumed.
 */
function useToolbarFold(ref: React.RefObject<HTMLElement | null>): boolean {
  const [folded, setFolded] = useState(false);
  const needed = useRef(0); // the width the unfolded toolbar wanted when it last overflowed
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      if (!folded && el.scrollWidth > el.clientWidth + 1) {
        needed.current = el.scrollWidth;
        setFolded(true);
      } else if (folded && el.clientWidth >= needed.current) setFolded(false);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check); // the name or the update notice changed
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [folded, ref]);
  return folded;
}

function SnapToggle() {
  const snap = useStore((s) => s.snap);
  return <label className="toggle" title="Snap positions to 0.25 units"><input type="checkbox" checked={snap} onChange={(e) => setState({ snap: e.target.checked })} /> Snap</label>;
}

function IntroToggle() {
  const autoIntro = useStore((s) => s.autoIntro);
  return <label className="toggle" title="New objects get a Create/Write step automatically"><input type="checkbox" checked={autoIntro} onChange={(e) => setState({ autoIntro: e.target.checked })} /> Auto-intro</label>;
}

function RecordToggle() {
  const record = useStore((s) => s.record);
  return (
    <label data-tour="record" className={`toggle ${record ? 'rec' : ''}`} title="Canvas drags, resizes and rotations become .animate clips at the playhead instead of changing the starting state">
      <input type="checkbox" checked={record} onChange={(e) => setState({ record: e.target.checked })} /> ● Record
    </label>
  );
}

function AutoRenderToggle() {
  const autoRender = useStore((s) => s.autoRender);
  return (
    <label className="toggle" title="Render a smooth preview with manim in the background after each edit; Space plays it">
      <input type="checkbox" checked={autoRender} onChange={(e) => { setState({ autoRender: e.target.checked }); if (e.target.checked) void renderPreview(); }} /> Auto-render
    </label>
  );
}

/** The four toggles in one menu, for a window too narrow to show them in the toolbar. */
function OptionsMenu() {
  const record = useStore((s) => s.record);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), close());
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);
  return (
    <>
      <button
        data-tour="record" className={`ghost ${at ? 'on' : ''} ${record ? 'rec' : ''}`} aria-haspopup="menu" aria-expanded={!!at}
        title="Snap, Auto-intro, Record and Auto-render"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4 }); }}
      >
        {record ? '● ' : ''}Options ▾
      </button>
      {at && (
        <div className="options-menu" role="menu" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
          <SnapToggle />
          <IntroToggle />
          <RecordToggle />
          <AutoRenderToggle />
        </div>
      )}
    </>
  );
}

export function Toolbar() {
  const path = useStore((s) => s.path);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const bar = useRef<HTMLElement>(null);
  const narrow = useToolbarFold(bar);
  const name = path ? path.split(/[\\/]/).pop() : 'Untitled';
  return (
    <header className={`toolbar ${narrow ? "folded" : ""}`} ref={bar}>
      <button className="brand" title="Home: projects and samples" onClick={() => setState({ home: true })}><img className="brand-icon" src="icon.png" alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />{!narrow && 'Manim Studio'}</button>
      <button className="ghost home-btn" title="Home: new, recent and sample projects" onClick={() => setState({ home: true })}>⌂ Home</button>
      <span className="muted proj-name" title={path ?? 'Not saved yet'}>{name}{dirty ? ' •' : ''}</span>
      <button className="ghost" title={`New project: choose its format (${keys('⌘N')})`} onClick={() => setState({ panel: 'new-project' })}>New</button>
      <button className="ghost" title={`Open a project or manim file (${keys('⌘O')})`} onClick={() => openProject().catch((e) => toast(String(e)))}>Open</button>
      <button className="ghost" title={`Save (${keys('⌘S')}); ${keys('⇧⌘S')} saves a copy`} onClick={() => saveProject().catch((e) => toast(String(e)))}>Save</button>
      <span className="sep" />
      <button className="ghost" disabled={!canUndo} onClick={undo} title={`Undo (${keys('⌘Z')})`}>↶</button>
      <button className="ghost" disabled={!canRedo} onClick={redo} title={`Redo (${keys('⇧⌘Z')})`}>↷</button>
      <span className="sep" />
      {narrow ? <OptionsMenu /> : (
        <>
          <SnapToggle />
          <IntroToggle />
          <RecordToggle />
        </>
      )}
      <div className="spacer" />
      <UpdateNotice />
      <button data-tour="graph" className="ghost" title="Graph a function from an expression, with parameter sliders" onClick={() => setState({ panel: 'graph', panelData: null })}>ƒ Graph</button>
      <span className="toolbar-group" data-tour="output">
        {!narrow && <AutoRenderToggle />}
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
  const running = video && (video.state === 'running' || video.state === 'queued') && !fresh;
  const stale = !fresh && !running;
  return (
    <button
      className={`render-status ${fresh ? 'ok' : running ? 'busy' : 'stale'}`}
      title={fresh ? 'Smooth preview is up to date: Space plays it' : running ? video?.message : video?.state === 'error' ? video.message : 'Render a smooth preview now'}
      onClick={() => (fresh ? (setState({ time: getState().time >= sequenceEnd(getState().doc, getState().timeline) - 1e-3 ? 0 : getState().time }), setPlaying(true)) : stale && renderPreview())}
    >
      {fresh ? '● Preview ready' : running ? `Rendering ${Math.round((video?.progress ?? 0) * 100)}%` : video?.state === 'error' && video.key === docKey(getState().doc) ? '● Render failed' : '● Render preview'}
    </button>
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

/** A project was opened that has unsaved changes from an earlier session: restore them or keep the saved file. */
function RestoreDialog() {
  const r = useStore((s) => s.restore);
  if (!r) return null;
  const close = () => setState({ restore: null });
  const restore = async () => {
    close();
    try {
      const res = await api.openRecovery(r.id);
      loadDoc(res.doc, res.path, r.id);
      toast(`Restored the unsaved changes to ${r.name}. Save to keep them.`);
    } catch (e) {
      toast(String(e));
    }
  };
  const keepSaved = () => {
    close();
    api.clearRecovery(r.id).catch(() => undefined);
  };
  return (
    <div className="modal-back leave-back">
      <div className="modal" role="alertdialog" aria-label="Unsaved changes found">
        <div className="modal-head"><h3>Restore unsaved changes to {r.name}?</h3></div>
        <p className="muted">The app closed before these changes were saved. The file on disk is the version you last saved.</p>
        <div className="row actions">
          <span className="spacer" />
          <button onClick={keepSaved}>Keep the saved file</button>
          <button className="primary" autoFocus onClick={() => void restore()}>Restore changes</button>
        </div>
      </div>
    </div>
  );
}

export function Panels() {
  return (
    <>
      <PanelDialog />
      <RestoreDialog />
      <LeaveDialog />
    </>
  );
}

function PanelDialog() {
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
  const suggested = `${path ? path.split(/[\\/]/).pop()!.replace(PROJECT_EXT, '') : doc.scene.name || 'scene'}.mp4`;
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<string | null>(null);
  useEffect(() => () => { jobRef.current = null; }, []);

  const start = async () => {
    let out = output;
    if (!out) {
      out = (await askPath('save', suggested, ['MP4 video (*.mp4)'], 'Save video to path:')) ?? '';
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
          <button className="ghost" onClick={async () => { const p = await askPath('save', suggested, ['MP4 video (*.mp4)'], 'Save video to path:'); if (p) setOutput(p); }}>Browse</button>
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
          <>
            {job?.state === 'done' && job.id && (
              <>
                <button onClick={() => api.reveal(job.id!, 'show').then((r) => r.ok || toast("Couldn't open the folder")).catch((e) => toast(String(e)))}>Show in folder</button>
                <button onClick={() => api.reveal(job.id!, 'open').then((r) => r.ok || toast("Couldn't open the video")).catch((e) => toast(String(e)))}>Play</button>
              </>
            )}
            <button className="primary" onClick={() => start().catch((e) => toast(String(e)))}>{job?.state === 'done' ? 'Render again' : 'Render with manim'}</button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // A checkbox that still has focus after a click isn't a text field: Space plays, letters are shortcuts.
      const typing = (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes((el as HTMLInputElement).type)) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (getState().home) {
        // Home screen: only the project shortcuts (the editor behind it isn't shown).
        if (mod && (k === 'o' || k === 'n')) {
          e.preventDefault();
          if (k === 'o') void openProject().catch((err) => toast(String(err)));
          else setState({ panel: 'new-project' });
        } else if (e.key === 'F1') setState({ panel: 'help', panelData: null });
        else if (e.key === 'Escape') {
          // Close the open dialog; with none open, go back to the project behind Home.
          const s = getState();
          if (s.panel && (!typing || s.panel === 'help')) setState({ panel: null, panelData: null });
          else if (!s.panel && !typing && s.hasProject) setState({ home: false });
        }
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
      if (mod && k === 'n') {
        e.preventDefault();
        setState({ panel: 'new-project' });
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setState({ panel: 'help', panelData: null });
        return;
      }
      if (e.key === 'Escape' && typing && getState().panel === 'help') return setState({ panel: null, panelData: null }); // from its search box
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
      else if (mod && k === 'x') cutClips();
      else if (mod && k === 'v') pasteClips();
      else if (mod && k === 'd') {
        e.preventDefault();
        if (selectedObjectIds().length) duplicateObjects(selectedObjectIds());
      } else if (mod || e.altKey) {
        // Any other Ctrl / ⌘ / Alt combination belongs to the system: ⌘M minimises, Ctrl+= zooms the page…
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
      } else if (e.key === '/' && !mod) {
        const search = document.querySelector<HTMLInputElement>('.library .search'); // the library's search box
        if (search) {
          e.preventDefault();
          search.focus();
        }
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
