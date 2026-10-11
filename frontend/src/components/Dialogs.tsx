// Graph builder, delete-with-dependents, and reusable construction dialogs.

import { useEffect, useMemo, useState } from 'react';
import { api, type FunctionAnalysis } from '../api';
import { dependentsOf, geoType, literal, RESERVED_NAMES, sortByDependencies } from '../construct';
import {
  chooseTrack, createParam, deleteObjects, emptyDoc, frameSnap, getState, params, selectObjects, setState, toast, uid, uniqueName, updateDoc, useStore,
} from '../store';
import { closure, defaultInputs, insertTemplate, makeTemplate, saveTemplate, suggestInputs } from '../templates';
import type { Pt, SceneDoc, SceneObject, Template, TemplateInput } from '../types';
import { Modal } from './Modal';
import { ColorField, Field } from './ParamField';

const close = () => setState({ panel: null, panelData: null });

interface ParamDef { value: number; min: number; max: number; step: number }

/** Expression-first graph builder: axes + graph + parameter sliders in one step. */
export function GraphBuilder() {
  const doc = useStore((s) => s.doc);
  const frame = useStore((s) => s.frame);
  const preset = useStore((s) => s.panelData as { axes?: string } | null);
  const axesList = doc.objects.filter((o) => geoType(o, doc) === 'axes');
  const [expr, setExpr] = useState('y = a*x^2 + b');
  const [axesId, setAxesId] = useState<string>(preset?.axes ?? axesList[0]?.id ?? 'new');
  const [ax, setAx] = useState({ xmin: -5, xmax: 5, xstep: 1, ymin: -3, ymax: 3, ystep: 1, xlen: 10, ylen: 6 });
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const [defs, setDefs] = useState<Record<string, ParamDef>>({});
  const [color, setColor] = useState('BLUE');
  const [disc, setDisc] = useState<number[] | null>(null);
  const [analysis, setAnalysis] = useState<FunctionAnalysis | null>(null);

  const existingAxes = frame?.objects.find((o) => o.id === axesId)?.axes;
  const xr: [number, number] = axesId === 'new' ? [ax.xmin, ax.xmax] : existingAxes?.x_range ?? [-5, 5];
  const yr: [number, number] = axesId === 'new' ? [ax.ymin, ax.ymax] : existingAxes?.y_range ?? [-3, 3];
  const dom = domain ?? xr;
  const trackers = Object.fromEntries(params(doc).map((p) => [p.name, frame?.values?.[p.name] ?? literal(p.args['*']) ?? 1]));
  const values = { ...trackers, ...Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, v.value])) };

  useEffect(() => {
    const t = setTimeout(() => api.analyzeFunction(expr, values, dom, yr).then(setAnalysis).catch((e) => toast(String(e))), 250);
    return () => clearTimeout(t);
  }, [expr, JSON.stringify(values), dom[0], dom[1], yr[0], yr[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  // New parameter names get default slider settings.
  const newParams = (analysis?.params ?? []).filter((p) => !(p in trackers));
  useEffect(() => {
    setDefs((d) => {
      const next = { ...d };
      for (const p of newParams) next[p] ??= { value: 1, min: -5, max: 5, step: 0.1 };
      return next;
    });
  }, [newParams.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const clashes = newParams.filter((p) => p === 'x' || RESERVED_NAMES.has(p) || doc.objects.some((o) => o.name === p && o.ctor !== 'ValueTracker'));
  const breaks = disc ?? analysis?.discontinuities ?? [];
  const canCreate = analysis?.ok && !clashes.length;

  /**
   * Add the parameters, axes (if new) and graph to `d`; returns the graph and the end of its intro.
   * Used both to create them and to build the preview, so the preview shows exactly what gets added.
   */
  const addGraph = (d: SceneDoc, start: number, intro: 'Create' | 'add'): { graph: SceneObject; end: number } => {
    for (const p of newParams) createParam(d, p, defs[p]?.value ?? 1, { min: defs[p]?.min ?? -5, max: defs[p]?.max ?? 5, step: defs[p]?.step ?? 0.1 });
    let axes = d.objects.find((o) => o.id === axesId);
    let t = start;
    const show = (target: string) => {
      if (intro === 'add') d.clips.push({ id: uid('c'), kind: 'add', track: chooseTrack(d, t, 0), start: t, duration: 0, targets: [target] });
      else {
        d.clips.push({ id: uid('c'), kind: 'anim', track: chooseTrack(d, t, 1), start: t, duration: 1, cls: 'Create', target, args: {} });
        t += 1;
      }
    };
    if (!axes) {
      axes = {
        id: uid('o'), name: uniqueName(d, 'axes'), ctor: 'Axes', pos: null, chain: '',
        args: { x_range: `[${ax.xmin}, ${ax.xmax}, ${ax.xstep}]`, y_range: `[${ax.ymin}, ${ax.ymax}, ${ax.ystep}]`, x_length: String(ax.xlen), y_length: String(ax.ylen) },
      };
      d.objects.push(axes);
      show(axes.name);
    }
    const graph: SceneObject = {
      id: uid('o'), name: uniqueName(d, 'graph'), ctor: `${axes.name}.plot`, args: { color }, pos: null, chain: '',
      link: { kind: 'graph', axes: axes.id, expr: expr.trim(), x_min: dom[0], x_max: dom[1], ...(breaks.length ? { discontinuities: breaks, gap: analysis?.gap ?? 0.01 } : {}) },
    };
    d.objects.push(graph);
    show(graph.name);
    sortByDependencies(d);
    return { graph, end: t };
  };

  const create = () => {
    if (!analysis?.ok) return;
    const start = frameSnap(getState().time);
    let graphId = '';
    let endTime = start;
    updateDoc((d) => {
      const r = addGraph(d, start, 'Create');
      graphId = r.graph.id;
      endTime = r.end;
    });
    close();
    selectObjects([graphId]);
    setState({ time: endTime }); // show the graph once its Create clip has played
  };

  // Preview: the same objects in a scratch scene, rendered by manim (existing parameters at their playhead values).
  const [preview, setPreview] = useState<{ image: string | null; error: string | null; busy: boolean }>({ image: null, error: null, busy: false });
  const previewKey = canCreate ? JSON.stringify([expr, axesId, ax, dom, defs, color, breaks, analysis?.gap, values]) : '';
  useEffect(() => {
    if (!previewKey) return;
    let alive = true;
    const timer = setTimeout(() => {
      const pd = emptyDoc();
      pd.config = { ...doc.config };
      for (const p of params(doc)) {
        const v = values[p.name];
        pd.objects.push({ ...structuredClone(p), args: { ...p.args, ...(v !== undefined ? { '*': String(v) } : {}) } });
      }
      const existing = doc.objects.find((o) => o.id === axesId);
      if (existing) {
        pd.objects.push(structuredClone(existing));
        pd.clips.push({ id: uid('c'), kind: 'add', track: 't1', start: 0, duration: 0, targets: [existing.name] });
      }
      addGraph(pd, 0, 'add');
      setPreview((p) => ({ ...p, busy: true }));
      api.run(pd, 0, true, 560)
        .then((r) => alive && setPreview({ image: r.image, error: r.error?.message ?? null, busy: false }))
        .catch((e) => alive && setPreview({ image: null, error: String(e), busy: false }));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (v: number, set: (v: number) => void, w = 'narrow') => <input className={`field num ${w}`} value={v} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) set(n); }} />;

  return (
    <Modal title="Graph a function" wide>
      <div className="graph-builder">
        <div>
          <label className="param"><span className="pname">Function</span>
            <Field className={`mono big ${analysis && !analysis.ok ? 'bad' : ''}`} value={expr} onChange={setExpr} placeholder="y = a*x^2 + b" />
          </label>
          {analysis && !analysis.ok && <div className="err-box">{analysis.error}{analysis.hint ? <><br /><span className="muted">{analysis.hint}</span></> : null}</div>}
          {analysis?.ok && <p className="muted small">Reads as <code>y = {analysis.normalized}</code>{analysis.notes.length ? ` · ${analysis.notes.join(' ')}` : ''}</p>}
          <p className="muted small">Supported: explicit functions of x with + − × ÷ ^, implicit multiplication (2x, 3(x+1)), sin cos tan exp ln log sqrt abs floor… and pi, e. Not yet: implicit equations (x² + y² = 1), inequalities, parametric or polar curves, piecewise definitions.</p>

          <h4>Parameters</h4>
          {(analysis?.params ?? []).length === 0 && <p className="muted small">None. Any other letter (like a, b, k) becomes a parameter slider you can animate on the timeline.</p>}
          {(analysis?.params ?? []).map((p) => p in trackers ? (
            <div key={p} className="row"><span className="mono">{p}</span><span className="muted small">shared: uses the existing parameter ({trackers[p]})</span></div>
          ) : (
            <div key={p} className="row param-def">
              <span className="mono">{p}</span>
              <span className="muted small">value</span>{num(defs[p]?.value ?? 1, (v) => setDefs({ ...defs, [p]: { ...defs[p], value: v } }))}
              <span className="muted small">min</span>{num(defs[p]?.min ?? -5, (v) => setDefs({ ...defs, [p]: { ...defs[p], min: v } }))}
              <span className="muted small">max</span>{num(defs[p]?.max ?? 5, (v) => setDefs({ ...defs, [p]: { ...defs[p], max: v } }))}
              <span className="muted small">step</span>{num(defs[p]?.step ?? 0.1, (v) => setDefs({ ...defs, [p]: { ...defs[p], step: v } }))}
              {clashes.includes(p) && <span className="err-text small">{p === 'x' ? 'x is the variable' : 'name already used'}</span>}
            </div>
          ))}
        </div>
        <div>
          <div className={`graph-preview ${preview.busy ? 'busy' : ''}`} style={{ aspectRatio: `${doc.config.pixel_width} / ${doc.config.pixel_height}`, background: doc.config.background_color }}>
            {canCreate && preview.image && <img src={preview.image} alt="Preview of the graph" />}
            {!canCreate && <span className="muted small">{analysis && !analysis.ok ? 'Fix the expression to see a preview' : clashes.length ? 'Rename the clashing parameter to see a preview' : 'Preview'}</span>}
            {canCreate && preview.error && <span className="err-text small">{preview.error}</span>}
            {canCreate && !preview.image && !preview.error && <span className="muted small">Rendering preview…</span>}
            <span className="graph-preview-label">Preview · rendered by manim{preview.busy ? ' · updating…' : ''}</span>
          </div>
          <label className="param"><span className="pname">Axes</span>
            <select className="field" value={axesId} onChange={(e) => { setAxesId(e.target.value); setDomain(null); }}>
              {axesList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value="new">New axes</option>
            </select>
          </label>
          {axesId === 'new' && (
            <>
              <div className="row"><span className="muted small w60">x range</span>{num(ax.xmin, (v) => setAx({ ...ax, xmin: v }))}{num(ax.xmax, (v) => setAx({ ...ax, xmax: v }))}<span className="muted small">step</span>{num(ax.xstep, (v) => setAx({ ...ax, xstep: v }))}</div>
              <div className="row"><span className="muted small w60">y range</span>{num(ax.ymin, (v) => setAx({ ...ax, ymin: v }))}{num(ax.ymax, (v) => setAx({ ...ax, ymax: v }))}<span className="muted small">step</span>{num(ax.ystep, (v) => setAx({ ...ax, ystep: v }))}</div>
              <div className="row"><span className="muted small w60">size</span>{num(ax.xlen, (v) => setAx({ ...ax, xlen: v }))}<span className="muted small">×</span>{num(ax.ylen, (v) => setAx({ ...ax, ylen: v }))}</div>
            </>
          )}
          <div className="row"><span className="muted small w60">domain</span>{num(dom[0], (v) => setDomain([v, dom[1]]))}{num(dom[1], (v) => setDomain([dom[0], v]))}{domain && <button className="ghost small" onClick={() => setDomain(null)}>= axes</button>}</div>
          <div className="param"><span className="pname">Color</span><ColorField value={color} onChange={(c) => setColor(c || 'BLUE')} /></div>

          <h4>Discontinuities</h4>
          {analysis?.ok && (
            <>
              {breaks.length === 0 && <p className="muted small">None found in the domain.</p>}
              <div className="chips">
                {breaks.map((b, i) => <span key={i} className="chip value-chip mono">x = {Math.round(b * 10000) / 10000}<button className="x-btn" onClick={() => setDisc(breaks.filter((_, k) => k !== i))}>×</button></span>)}
              </div>
              {breaks.length > 0 && <p className="muted small">The curve is not drawn across these points (manim <code>discontinuities</code>, gap {analysis.gap ?? 0.01} on each side, chosen to keep asymptote branches inside the y range).</p>}
              {disc && <button className="ghost small" onClick={() => setDisc(null)}>Use detected</button>}
              {analysis.undefined_intervals.length > 0 && <p className="warn small">Undefined for x in {analysis.undefined_intervals.map(([a, b]) => `[${Math.round(a * 100) / 100}, ${Math.round(b * 100) / 100}]`).join(', ')}. Narrow the domain to where the function is defined.</p>}
            </>
          )}
        </div>
      </div>
      <div className="row actions">
        <span className="muted small">{axesId === 'new' ? 'Creates axes, ' : ''}{newParams.length ? `${newParams.length} parameter slider${newParams.length > 1 ? 's' : ''}, ` : ''}and the graph, with Create clips at the playhead.</span>
        <span className="spacer" />
        <button onClick={close}>Cancel</button>
        <button className="primary" disabled={!canCreate} onClick={create}>Create graph</button>
      </div>
    </Modal>
  );
}

/** Deleting objects that others are built from: delete those too, or keep them as independent objects. */
export function DeleteDialog() {
  const doc = useStore((s) => s.doc);
  const ids = (useStore((s) => s.panelData) as string[] | null) ?? [];
  const deps = dependentsOf(doc, ids, false);
  const names = doc.objects.filter((o) => ids.includes(o.id)).map((o) => o.name);
  return (
    <Modal title={`Delete ${names.join(', ')}`}>
      <p>{deps.length === 1 ? 'This object is' : 'These objects are'} built from {names.length === 1 ? 'it' : 'them'}:</p>
      <div className="chips">{deps.map((d) => <span key={d.id} className="chip mono">{d.name}</span>)}</div>
      <p className="muted small"><b>Keep them</b> leaves points, labels, lines, circles and polygons where they are now, as independent objects (their relationship is forgotten); constructions that can't exist without their source (angles, areas, braces…) are deleted either way. Uncoupled objects just forget the relationship.</p>
      <div className="row actions">
        <button onClick={close}>Cancel</button>
        <button onClick={() => deleteObjects(ids, 'detach')}>Keep them, delete {names.length === 1 ? names[0] : 'these'}</button>
        <button className="danger" onClick={() => deleteObjects(ids, 'cascade')}>Delete all ({ids.length + deps.length})</button>
      </div>
    </Modal>
  );
}

/** Insert an instance of a construction, choosing its inputs. */
export function InsertConstruction() {
  const t = useStore((s) => s.panelData as Template | null);
  const [values, setValues] = useState<Record<string, string>>(() => (t ? defaultInputs(t) : {}));
  const [linked, setLinked] = useState(false);
  const [offset, setOffset] = useState<Pt>([0, 0]);
  if (!t) return null;
  return (
    <Modal title={`Insert ${t.name}`}>
      {t.description && <p className="muted">{t.description}</p>}
      {t.inputs.map((inp) => <InputField key={inp.id} inp={inp} value={values[inp.id] ?? inp.default} onChange={(v) => setValues({ ...values, [inp.id]: v })} />)}
      <label className="param"><span className="pname">Offset</span>
        <div className="row">
          <input className="field num narrow" value={offset[0]} onChange={(e) => setOffset([Number(e.target.value) || 0, offset[1]])} />
          <input className="field num narrow" value={offset[1]} onChange={(e) => setOffset([offset[0], Number(e.target.value) || 0])} />
        </div>
      </label>
      <div className="seg">
        <button className={!linked ? 'on' : ''} onClick={() => setLinked(false)}>Independent copy</button>
        <button className={linked ? 'on' : ''} onClick={() => setLinked(true)}>Linked to template</button>
      </div>
      <p className="muted small">{linked ? 'Linked instances are regenerated when the template changes (Update instances); only their inputs are their own.' : 'An independent copy has no tie to the template: edit it freely.'} Either way it gets its own objects and names.</p>
      <div className="row actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={() => { insertTemplate(t, values, linked, offset); close(); }}>Insert at playhead</button>
      </div>
    </Modal>
  );
}

function InputField({ inp, value, onChange }: { inp: TemplateInput; value: string; onChange: (v: string) => void }) {
  return (
    <label className="param">
      <span className="pname">{inp.label}</span>
      {inp.kind === 'color' ? <ColorField value={value} onChange={(v) => onChange(v || inp.default)} />
        : inp.kind === 'visible' ? <div className="seg"><button className={value === 'True' ? 'on' : ''} onClick={() => onChange('True')}>show</button><button className={value !== 'True' ? 'on' : ''} onClick={() => onChange('False')}>hide</button></div>
          : <Field className={inp.kind === 'param' ? 'mono num' : 'mono'} value={value} onChange={onChange} />}
    </label>
  );
}

/** Save the selection (with what it is built from) as a reusable construction. */
export function SaveConstruction() {
  const doc = useStore((s) => s.doc);
  const ids = (useStore((s) => s.panelData) as string[] | null) ?? [];
  const objs = useMemo(() => closure(doc, ids), [doc, ids]);
  const added = objs.filter((o) => !ids.includes(o.id));
  const [name, setName] = useState('My construction');
  const [description, setDescription] = useState('');
  const [where, setWhere] = useState<'project' | 'library'>('project');
  const [inputs, setInputs] = useState(() => suggestInputs(objs));
  const save = async () => {
    try {
      const t = makeTemplate(doc, objs, name.trim() || 'Construction', description, inputs.filter((i) => i.use).map(({ use: _u, ...i }) => (void _u, i)));
      await saveTemplate(t, where);
      close();
    } catch (e) {
      toast(String(e));
    }
  };
  return (
    <Modal title="Save as construction">
      <label className="param"><span className="pname">Name</span><Field value={name} onChange={setName} /></label>
      <label className="param"><span className="pname">Description</span><Field value={description} onChange={setDescription} /></label>
      <p className="muted small">Includes {objs.map((o) => o.name).join(', ')}.{added.length ? ` Added because the selection is built from them: ${added.map((o) => o.name).join(', ')}.` : ''} Timeline clips of these objects are saved too.</p>
      <h4>Inputs offered when inserting</h4>
      {inputs.length === 0 && <p className="muted small">No parameters, labels or colors to expose.</p>}
      {inputs.map((inp, i) => (
        <div key={inp.id} className="row">
          <input type="checkbox" checked={inp.use} onChange={(e) => setInputs(inputs.map((x, k) => (k === i ? { ...x, use: e.target.checked } : x)))} />
          <span className="muted small w60">{inp.kind}</span>
          <Field value={inp.label} onChange={(v) => setInputs(inputs.map((x, k) => (k === i ? { ...x, label: v } : x)))} />
          <span className="muted small mono">{inp.default}</span>
        </div>
      ))}
      <div className="seg">
        <button className={where === 'project' ? 'on' : ''} onClick={() => setWhere('project')}>This project</button>
        <button className={where === 'library' ? 'on' : ''} onClick={() => setWhere('library')}>My library (all projects)</button>
      </div>
      <div className="row actions">
        <button onClick={close}>Cancel</button>
        <button className="primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}
