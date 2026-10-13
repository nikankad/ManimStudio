import { useState } from 'react';
import { api } from '../api';
import {
  addAnimation, addObject, docLayout, uid, getState, objectClasses, deleteSelection, duplicateObject, fps, frameSnap, renameObject, sceneBase, selectClips, setState,
  timecode, toast, toggleDisabled, updateDoc, useSignature, useStore, setMarker, deleteMarker,
} from '../store';
import { addChild, anchorTo, compoundOf, compounds, EPS, isClause, findAnim, layout, MARKER_CATEGORIES, markerTime, findStep, groupAnims, literal, newAnim, removeIds, reorder, retime, targetsOf, ungroup, walk, type AnimRef } from '../timeline';
import { ratePath } from './rates';
import { CodeArea } from './CodeArea';
import { animLabel, markerWhere, stepLabel } from './Timeline';
import { type Call, formatChain, parseArgs, parseChain } from '../pyparse';
import type { Anim, Args, Marker, Param, SceneDoc, SceneObject, Step } from '../types';
import { ColorField, Field, ParamField, ScrubNumber, isColorKey, quote, unquote } from './ParamField';
import { Tip, type TipContent } from './Tip';
import { versionLabel } from './Updates';
import { ActionsSection, CoupleSection, Diagnostics, GeometrySection, InstanceSection, LatexNotice, ParametersPanel, ParamSection, RelationshipSection } from './Construction';
import { DefinitionsPanel } from './Definitions';
import { EquationSection, TermsClipEditor } from './EquationEditor';
import { CONTROLLED_ARGS, isCoupled, isFollow, isRedraw, ownsPosition, standsAlone } from '../construct';
import { addKey, CAMERA, CAMERA_NAME, CHANNELS, channelsOf, deleteKey, fixKey, keyframes, setBaseValue, setKeyArgs, setKeyValue, valueBefore, type Channel, type Key, type KeyValue } from '../keyframes';
import { coupleObjects, detachObjects, duplicateObjects, selectedObjectIds, uncoupleObjects, unwrapBlock } from '../store';
import { keys } from '../keys';

const TEXT_CTORS = new Set(['Text', 'Tex', 'MathTex', 'MarkupText', 'Paragraph', 'Title', 'SingleStringMathTex']);
const QUICK_ANIMS = ['Create', 'Write', 'FadeIn', 'FadeOut', 'Indicate', 'Circumscribe', 'Transform', 'ReplacementTransform', 'GrowFromCenter', 'Uncreate'];
const STYLE_KEYS = ['color', 'fill_color', 'fill_opacity', 'stroke_color', 'stroke_width', 'stroke_opacity'];

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  let body;
  if (selection?.kind === 'object') {
    const obj = doc.objects.find((o) => o.id === selection.id);
    body = obj ? <ObjectInspector key={obj.id} obj={obj} /> : null;
  } else if (selection?.kind === 'objects') {
    body = <MultiObjectInspector ids={selection.ids.filter((id) => doc.objects.some((o) => o.id === id))} />;
  } else if (selection?.kind === 'clips') {
    const ids = selection.ids.filter((id) => findStep(doc, id) || findAnim(doc, id));
    const step = ids.length === 1 ? findStep(doc, ids[0]) : undefined;
    const ref = ids.length === 1 && !step ? findAnim(doc, ids[0]) : undefined;
    if (step) body = <StepInspector key={step.id} step={step} />;
    else if (ref) body = <AnimInspector key={ref.anim.id} r={ref} />;
    else if (ids.length > 1) body = <MultiClipInspector ids={ids} />;
  } else if (selection?.kind === 'marker') {
    const m = doc.markers?.find((x) => x.id === selection.id);
    body = m ? <MarkerInspector key={m.id} m={m} /> : null;
  }
  return (
    <aside className="panel inspector" data-tour="inspector">
      <div className="panel-title">{selection?.kind === 'clips' ? 'Effect Controls' : selection?.kind === 'object' || selection?.kind === 'objects' ? 'Properties' : selection?.kind === 'marker' ? 'Marker' : 'Scene'}</div>
      <div className="scroll" tabIndex={-1}>{body ?? <SceneInfo />}</div>
    </aside>
  );
}

/**
 * A marker: its name, kind and notes, and what it is attached to. Attached to a clip's start or end (plus an offset),
 * it moves with the clip; otherwise it stays at its time.
 */
function MarkerInspector({ m }: { m: Marker }) {
  const doc = useStore((s) => s.doc);
  const timeline = useStore((s) => s.timeline);
  const time = useStore((s) => s.time);
  const lay = docLayout(doc, timeline);
  const at = markerTime(m, lay);
  // what it can be attached to: the steps and animations around it (and what it is attached to now)
  const near = (id: string) => {
    const sp = lay.anims.get(id) ?? lay.steps.get(id);
    return !!sp && at >= sp.start - 0.5 && at <= sp.end + 0.5;
  };
  const options: { id: string; label: string }[] = [];
  for (const s of doc.timeline) {
    if (s.disabled) continue;
    if (s.kind !== 'play' && (near(s.id) || m.anchor?.id === s.id)) options.push({ id: s.id, label: `${stepLabel(s).name} ${stepLabel(s).sub}`.trim() });
    if (s.kind === 'play') {
      if (near(s.id) || m.anchor?.id === s.id) options.push({ id: s.id, label: `Play together (${(s.anims ?? []).length})` });
      for (const a of walk(s.anims)) if (!a.disabled && (near(a.id) || m.anchor?.id === a.id)) options.push({ id: a.id, label: [animLabel(a).name, animLabel(a).sub].filter(Boolean).join(' ') });
    }
  }
  const attach = (id: string) => setMarker(m.id, (x) => {
    const anchor = id ? anchorTo(lay, id, at) : undefined;
    if (anchor) x.anchor = anchor;
    else delete x.anchor;
    x.time = Math.round(at * 1000) / 1000;
  });
  const setEdge = (edge: 'start' | 'end') => setMarker(m.id, (x) => {
    const sp = x.anchor && (lay.anims.get(x.anchor.id) ?? lay.steps.get(x.anchor.id));
    if (x.anchor && sp) x.anchor = { ...x.anchor, edge, offset: Math.round((at - sp[edge]) * 1000) / 1000 };
  });
  const moveTo = (t: number) => setMarker(m.id, (x) => {
    t = Math.max(0, frameSnap(t));
    const sp = x.anchor && (lay.anims.get(x.anchor.id) ?? lay.steps.get(x.anchor.id));
    if (x.anchor && sp) x.anchor.offset = Math.round((t - sp[x.anchor.edge]) * 1000) / 1000;
    x.time = t;
  }, 'time');
  return (
    <div className="pad marker-insp">
      <h3>Marker</h3>
      <section className="fx-section">
        <div className="fx-row"><span>Name</span><Field ariaLabel="Marker name" value={m.label ?? ''} placeholder="Name it (it shows on the ruler)"
          onChange={() => {}} onBlur={(v) => v.trim() !== (m.label ?? '') && setMarker(m.id, (x) => { if (v.trim()) x.label = v.trim(); else delete x.label; })} /></div>
        <div className="fx-row"><span>Kind</span>
          <div className="seg marker-kind" role="group" aria-label="Marker kind">
            <button className={!m.category ? 'on' : ''} aria-pressed={!m.category} onClick={() => setMarker(m.id, (x) => void delete x.category)}>None</button>
            {MARKER_CATEGORIES.map((c) => (
              <button key={c.id} className={m.category === c.id ? 'on' : ''} aria-pressed={m.category === c.id} onClick={() => setMarker(m.id, (x) => void (x.category = c.id))}>{c.label}</button>
            ))}
          </div>
        </div>
        <div className="fx-row"><span>Notes</span><Field ariaLabel="Marker notes" multiline value={m.notes ?? ''} placeholder="What happens here, what to say, what to check…"
          onChange={(v) => setMarker(m.id, (x) => { if (v) x.notes = v; else delete x.notes; }, 'notes')} /></div>
      </section>
      <section className="fx-section">
        <h4>Time</h4>
        <div className="fx-row"><span>At</span><ScrubNumber value={at} min={0} step={1 / fps()} precision={3} suffix="s" onChange={moveTo} />
          <span className="muted small mono">{timecode(at)}</span></div>
        <div className="fx-row"><span /><button className="ghost small" disabled={Math.abs(time - at) < 1e-6} onClick={() => moveTo(time)}>Move to playhead</button></div>
        <div className="fx-row"><span>Attached to</span>
          <select aria-label="Attached to" value={m.anchor?.id ?? ''} onChange={(e) => attach(e.target.value)}>
            <option value="">Nothing: stays at its time</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        {m.anchor && (
          <div className="fx-row"><span>From its</span>
            <div className="seg" role="group" aria-label="Attached at">
              <button className={m.anchor.edge === 'start' ? 'on' : ''} aria-pressed={m.anchor.edge === 'start'} onClick={() => setEdge('start')}>Start</button>
              <button className={m.anchor.edge === 'end' ? 'on' : ''} aria-pressed={m.anchor.edge === 'end'} onClick={() => setEdge('end')}>End</button>
            </div>
            <span className="muted small">{m.anchor.offset ? `${m.anchor.offset > 0 ? '+' : '−'}${Math.abs(m.anchor.offset)} s` : ''}</span>
          </div>
        )}
        <p className="muted small">{markerWhere(m, doc)}{m.anchor ? ': it moves when that clip moves or changes length.' : '. Attach it to a clip to move it with the clip.'}</p>
      </section>
      <div className="row"><button className="ghost small danger" onClick={() => deleteMarker(m.id)}>Delete marker</button></div>
    </div>
  );
}

function SceneInfo() {
  const catalog = useStore((s) => s.catalog);
  const app = useStore((s) => s.app);
  const doc = useStore((s) => s.doc);
  return (
    <div className="pad">
      <p className="muted">
        <b>{doc.scene.name}</b>({doc.scene.base}) · {doc.config.pixel_width}×{doc.config.pixel_height} @ {doc.config.frame_rate}fps
      </p>
      <div className="row">
        <button onClick={() => setState({ panel: 'settings' })}>Scene settings…</button>
        <button onClick={() => setState({ panel: 'help', panelData: null })}>Guide &amp; tour</button>
      </div>
      <ParametersPanel />
      <DefinitionsPanel />
      <h4>How it works</h4>
      <ul className="tips">
        <li><b>Draw</b> with the tools above the canvas (keys 1–7): points, segments, arrows, circles, rectangles, polygons. Drawing between existing points connects to them.</li>
        <li>Select objects (Shift-click for several) to <b>connect</b> them: segments, midpoints, angle marks, labels, points on graphs… They stay attached while you edit and animate.</li>
        <li><b>ƒ Graph</b> builds axes and a graph from an expression like <code>y = a*x^2 + b</code>, with parameter sliders you can animate.</li>
        <li>The <b>Constructions</b> tab holds reusable pieces: a labeled triangle, the unit circle, a number line, secant-to-tangent, and your own.</li>
        <li>Drag any manim class onto the <b>canvas</b> or straight onto a <b>timeline track</b>.</li>
        <li>The timeline is the scene’s <code>construct()</code>: each <b>self.play</b> is a <b>Play together</b> group whose animations run at once (animation lanes V1, V2… hold its 1st, 2nd… animation; they are not drawing layers, see Scene › Drawing order), then the next statement starts. Drag clips to move them, drag their right edges to trim, and Alt-drag to duplicate.</li>
        <li>The <b>Code</b> tab shows the same scene as manim code. Edit it, or paste a whole manim file, and the timeline follows.</li>
        <li>On the canvas, drag an object to move it. Corner handles scale it, edge handles stretch it, and the top knob rotates it. With <b>Record</b> on, each of these becomes an animation clip at the playhead.</li>
        <li>Every field takes Python, like <code>BLUE</code>, <code>UP * 2</code> or <code>lambda x: x**2</code>.</li>
        <li><b>Code</b> steps run any manim code, such as updaters or loops.</li>
      </ul>
      <h4>Keys</h4>
      <ul className="tips keys">
        <li><kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>↑</kbd><kbd>↓</kbd> edit points</li>
        <li><kbd>M</kbd> marker · <kbd>S</kbd> snap · <kbd>=</kbd>/<kbd>-</kbd> zoom · <kbd>\</kbd> fit</li>
        <li><kbd>Del</kbd> delete · <kbd>{keys('⇧Del')}</kbd> ripple delete · <kbd>{keys('⌘C')}</kbd>/<kbd>{keys('⌘V')}</kbd> clips</li>
      </ul>
      <LatexNotice />
      {catalog && <p className="muted small">Manim Studio {versionLabel(app)} · manim {catalog.manim_version}</p>}
    </div>
  );
}

function setObj(id: string, fn: (o: SceneObject) => void, key: string) {
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === id);
    if (o) fn(o);
  }, `${id}:${key}`);
}

function setArg(args: Args, k: string, v: string) {
  if (v.trim() === '') delete args[k];
  else args[k] = v;
}

function ObjectInspector({ obj }: { obj: SceneObject }) {
  const sig = useSignature(obj.ctor);
  const objects = useStore((s) => s.doc.objects);
  const chainCls = useChainClass(obj.name);
  const chainSig = useSignature(chainCls);
  const info = useStore((s) => s.frame?.objects.find((o) => o.id === obj.id));
  const isEquation = obj.ctor === 'MathTex' || obj.ctor === 'Tex';
  const content = TEXT_CTORS.has(obj.ctor) && !isEquation ? unquote(obj.args['*'] ?? '') : null;
  const terms = useStore((s) => (s.selection?.kind === 'object' && s.selection.id === obj.id ? s.selection.terms : undefined));
  const isVector = sig?.vector ?? true;
  const paramNames = new Set(sig?.params.map((p) => p.name) ?? []);
  const styleKeys = STYLE_KEYS.filter((k) => paramNames.has(k) || obj.args[k] !== undefined);
  // Arguments the construction supplies (a segment's start/end, a brace's mobject…) aren't edited here.
  const controlled = new Set(obj.link && !standsAlone(obj) ? CONTROLLED_ARGS[obj.link.kind] ?? [] : []);

  const commitName = (v: string) => {
    if (v === obj.name) return;
    if (!/^[A-Za-z_]\w*$/.test(v)) return toast('Name must be a valid Python identifier');
    if (objects.some((o) => o.name === v)) return toast(`"${v}" is already used`);
    renameObject(obj.id, v);
  };
  const center = obj.pos ?? info?.center ?? null;
  const setPos = (i: 0 | 1, v: number) =>
    setObj(obj.id, (o) => {
      const p: [number, number] = o.pos ? [...o.pos] : center ? [...center] : [0, 0];
      p[i] = v;
      o.pos = p;
    }, 'pos' + i);

  return (
    <div className="pad">
      <div className="insp-head">
        <Field value={obj.name} onChange={() => undefined} onBlur={commitName} className="mono name" ariaLabel="Object name" />
        <span className="muted">=</span>
        <Field value={obj.ctor} onChange={(v) => setObj(obj.id, (o) => { o.ctor = v; delete o.positional; }, 'ctor')} list="me-mobjects" className="mono" ariaLabel="manim class" />
      </div>
      {sig?.doc && <p className="doc">{sig.doc}</p>}
      {sig?.unknown && !obj.link && <p className="warn small">Unknown constructor. It will still be passed to Python as written.</p>}
      {!obj.link && <Diagnostics id={obj.id} />}
      {obj.instance && <InstanceSection obj={obj} />}
      {obj.link ? <RelationshipSection obj={obj} /> : <CoupleSection obj={obj} />}
      {obj.ctor === 'ValueTracker' && <ParamSection obj={obj} />}
      {isEquation && <EquationSection obj={obj} />}
      <GeometrySection obj={obj} />

      {!isEquation && (content !== null || (TEXT_CTORS.has(obj.ctor) && !obj.args['*'])) && (
        <section>
          <h4>{obj.ctor === 'Text' || obj.ctor === 'MarkupText' || obj.ctor === 'Paragraph' ? 'Text' : 'LaTeX'}</h4>
          <Field multiline className="mono content" value={content ?? ''} onChange={(v) => setObj(obj.id, (o) => void (o.args['*'] = quote(v)), 'content')} />
        </section>
      )}

      {isRedraw(obj) ? null : <section className="fx-section">
        <h4>Transform {obj.pos && !isFollow(obj) && <button className="ghost small" title="Let manim position it" onClick={() => setObj(obj.id, (o) => void (o.pos = null), 'pos')}>auto position</button>}</h4>
        {isFollow(obj) ? <p className="muted small">Position comes from the construction (drag it on the canvas to change it).</p> : <div className="fx-row"><span>Position</span><ScrubNumber value={obj.pos?.[0] ?? center?.[0] ?? null} onChange={(v) => setPos(0, v)} step={0.02} /><ScrubNumber value={obj.pos?.[1] ?? center?.[1] ?? null} onChange={(v) => setPos(1, v)} step={0.02} /></div>}
        <div className="fx-row"><span>Scale</span><ScrubNumber value={obj.scale ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.scale = v), 'scale')} /></div>
        <div className="fx-row"><span>Stretch</span>
          <ScrubNumber value={obj.stretch?.[0] ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.stretch = [v, o.stretch?.[1] ?? 1]), 'sx')} />
          <ScrubNumber value={obj.stretch?.[1] ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.stretch = [o.stretch?.[0] ?? 1, v]), 'sy')} />
        </div>
        <div className="fx-row"><span>Rotation</span><ScrubNumber value={obj.rotation ?? 0} step={0.5} precision={1} suffix="°" onChange={(v) => setObj(obj.id, (o) => void (o.rotation = v), 'rot')} /></div>
      </section>}

      {isVector && styleKeys.length > 0 && (
        <section className="fx-section">
          <h4>Style</h4>
          {styleKeys.map((k) => {
            const p = sig?.params.find((x) => x.name === k);
            const v = obj.args[k] ?? '';
            const set = (nv: string) => setObj(obj.id, (o) => setArg(o.args, k, nv), 'arg:' + k);
            if (isColorKey(k)) return <div key={k} className="param"><span className="pname">{k}</span><ColorField value={v} onChange={set} placeholder={p?.default} /></div>;
            const num = v === '' ? null : parseFloat(v);
            const isOpacity = k.endsWith('opacity');
            return (
              <label key={k} className="param">
                <span className="pname">{k}</span>
                <div className="row">
                  <input type="range" className="slider" min={0} max={isOpacity ? 1 : 16} step={isOpacity ? 0.01 : 0.5} value={num ?? parseFloat(p?.default ?? '0') ?? 0} onChange={(e) => set(e.target.value)} />
                  <ScrubNumber value={num !== null && !Number.isNaN(num) ? num : null} placeholder={p?.default ?? '—'} min={0} max={isOpacity ? 1 : undefined} step={isOpacity ? 0.01 : 0.1} onChange={(nv) => set(String(nv))} />
                </div>
              </label>
            );
          })}
        </section>
      )}

      <ArgsEditor params={(sig?.params ?? []).filter((p) => !styleKeys.includes(p.name) && !controlled.has(p.name))} args={Object.fromEntries(Object.entries(obj.args).filter(([k]) => !styleKeys.includes(k) && !controlled.has(k)))} hideStar={content !== null || (isEquation && !!obj.eq?.parts?.length)} onChange={(k, v) => setObj(obj.id, (o) => setArg(o.args, k, v), 'arg:' + k)} />

      <ChainEditor title="Method chain" cls={chainCls} chain={obj.chain} placeholder=".set_fill(BLUE, opacity=0.5)" onChange={(v) => setObj(obj.id, (o) => void (o.chain = v), 'chain')} />

      {(chainSig?.factories?.length ?? 0) > 0 && (
        <section>
          <h4>Create from {obj.name}</h4>
          <div className="chips">
            {chainSig!.factories!.map((f) => <button key={f} className="chip" title={`New object = ${obj.name}.${f}(…)`} onClick={() => void createFrom(obj.name, chainCls, f)}>{f}</button>)}
          </div>
        </section>
      )}

      <KeyframeChannels obj={obj} />

      <ActionsSection ids={[obj.id]} terms={terms} />

      <CreatedSection obj={obj} />

      <section>
        <h4>Animate at playhead</h4>
        <div className="chips">
          {QUICK_ANIMS.map((a) => <button key={a} className="chip" onClick={() => addAnimation(a, obj.name)}>{a}</button>)}
          <button className="chip" onClick={() => addAnimation('animate', obj.name)}>.animate</button>
          {obj.eq?.parts?.length ? <button className="chip" title="Transform into another equation term by term" onClick={() => addTermsTransform(obj)}>Transform terms…</button> : null}
        </div>
      </section>

      <div className="row actions">
        <button onClick={() => duplicateObject(obj.id)}>Duplicate</button>
        <button title="Save as a reusable construction" onClick={() => setState({ panel: 'save-construction', panelData: [obj.id] })}>Save…</button>
        <button className="danger" onClick={() => deleteSelection()}>Delete</button>
      </div>
    </div>
  );
}

/** Where construct() creates the object, and the comment above it in the code. */
function CreatedSection({ obj }: { obj: SceneObject }) {
  const steps = useStore((s) => s.doc.timeline);
  return (
    <section>
      <h4><Tip tip={{ title: 'In the code', text: 'Where construct() creates this object: at the start, or right after a statement. Creating it later matters when it is placed relative to something that moves first (next_to, copy…). It is never created before what it is built from.' }}>In the code</Tip></h4>
      <div className="fx-row wide-row"><span>Created</span>
        <select className="field" aria-label="Where in construct() it is created" value={obj.after ?? ''} onChange={(e) => setObj(obj.id, (o) => { if (e.target.value) o.after = e.target.value; else delete o.after; }, 'after')}>
          <option value="">at the start of construct()</option>
          {steps.map((s, i) => <option key={s.id} value={s.id}>after {i + 1}. {stepLabel(s).title.split('\n')[0].slice(0, 48)}</option>)}
        </select>
      </div>
      <label className="param"><span className="pname">comment</span>
        <Field multiline className="mono" value={obj.comment ?? ''} placeholder="# what it is" onChange={(v) => setObj(obj.id, (o) => {
          if (v.trim()) o.comment = v.split('\n').map((l) => (l.trim() && !l.trim().startsWith('#') ? `# ${l.trim()}` : l.trim())).join('\n');
          else delete o.comment;
        }, 'comment')} />
      </label>
    </section>
  );
}

/** A TransformTerms animation of this equation at the playhead; the destination and pairs are set in Effect Controls. */
function addTermsTransform(obj: SceneObject) {
  const { doc } = getState();
  const other = doc.objects.find((o) => o.id !== obj.id && o.eq?.parts?.length);
  const id = addAnimation('TransformTerms', obj.name);
  updateDoc((d) => {
    const a = findAnim(d, id)?.anim;
    if (a) a.terms = { to: other?.id ?? '', pairs: [] };
  });
}

function MultiObjectInspector({ ids }: { ids: string[] }) {
  const doc = useStore((s) => s.doc);
  const objs = ids.map((id) => doc.objects.find((o) => o.id === id)!).filter(Boolean);
  return (
    <div className="pad">
      <h3>{objs.length} objects</h3>
      <p className="muted small mono">{objs.map((o) => o.name).join(', ')}</p>
      <ActionsSection ids={ids} />
      <div className="row actions">
        <button onClick={() => duplicateObjects(ids)} title="Copies keep links among themselves">Duplicate</button>
        {objs.some(isCoupled) && <button title="Pause their relationships: they stay where they are and can be edited freely" onClick={() => uncoupleObjects(ids)}>Uncouple</button>}
        {objs.some((o) => o.link && !isCoupled(o)) && <button title="Restore their paused relationships" onClick={() => coupleObjects(ids)}>Couple again</button>}
        {objs.some((o) => o.link) && <button title="Remove their relationships for good" onClick={() => detachObjects(ids)}>Forget relationships</button>}
        <button onClick={() => setState({ panel: 'save-construction', panelData: selectedObjectIds() })}>Save as construction…</button>
        <button className="danger" onClick={() => deleteSelection()}>Delete</button>
      </div>
    </div>
  );
}

/** First scene object (other than `owner`) whose class is one of `accepts` (any object when unrestricted). */
async function matchingObject(doc: SceneDoc, owner: string, accepts?: string[]): Promise<string | undefined> {
  for (const o of doc.objects) {
    if (o.name === owner) continue;
    if (!accepts?.length) return o.name;
    const sig = await api.signature(o.ctor, doc.header, objectClasses(doc)).catch(() => null);
    const cls = sig?.returns || o.ctor;
    if (accepts.includes(cls)) return o.name;
  }
  return undefined;
}

/** New object built by a factory method of another (axes.plot, axes.get_area…), required args prefilled. */
async function createFrom(owner: string, cls: string, method: string) {
  const { doc } = getState();
  const sig = await api.signature(`${cls}.${method}`, doc.header, objectClasses(doc)).catch(() => null);
  const initial: Args = {};
  for (const p of sig?.params ?? []) {
    if (!p.required) continue;
    if (p.kind === 'function' && p.template) initial[p.name] = p.template;
    else if (p.kind === 'mobject') initial[p.name] = (await matchingObject(doc, owner, p.accepts)) ?? '';
    else if (p.kind === 'number') initial[p.name] = '1';
    else if (p.kind === 'range') initial[p.name] = '[0, 1]';
  }
  addObject(`${owner}.${method}`, null, undefined, undefined, initial);
}

function ArgsEditor({ params, args, onChange, hideStar, title = 'Arguments' }: { params: Param[]; args: Args; onChange: (k: string, v: string) => void; hideStar?: boolean; title?: string }) {
  const [more, setMore] = useState(false);
  const [newKey, setNewKey] = useState('');
  // Starters like Text("Hello") store the first positional argument under "*"; show it in that parameter's field.
  const alias = !params.some((p) => p.name === '*') && args['*'] !== undefined ? params.find((p) => p.pos === 0) : undefined;
  const keyOf = (p: Param) => (p === alias ? '*' : p.name);
  const shown = params.filter((p) => !(hideStar && (p.name === '*' || p === alias)));
  const primary = shown.filter((p) => !p.from || p.required || p.kind === 'rate_func' || args[keyOf(p)] !== undefined);
  const inherited = shown.filter((p) => !primary.includes(p));
  const known = new Set(params.map(keyOf));
  const extra = Object.keys(args).filter((k) => !known.has(k) && !(hideStar && k === '*'));
  const field = (p: Param) => <ParamField key={p.name} param={p} value={args[keyOf(p)] ?? ''} siblings={args} onChange={(v) => onChange(keyOf(p), v)} />;
  return (
    <section>
      <h4>{title}</h4>
      {primary.map(field)}
      {extra.map((k) => (
        <ParamField key={k} param={{ name: k, label: k, kind: 'expr', default: '', required: false, annotation: '', from: '' }} value={args[k]} onChange={(v) => onChange(k, v)} onRemove={() => onChange(k, '')} />
      ))}
      {inherited.length > 0 && (
        <>
          <button className="ghost small" onClick={() => setMore(!more)}>
            {more ? '▾' : '▸'} {inherited.length} more ({[...new Set(inherited.map((p) => p.from))].join(', ')})
          </button>
          {more && inherited.map(field)}
        </>
      )}
      <div className="row">
        <input className="field mono" placeholder="other_kwarg" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <button className="ghost" disabled={!/^\w+$/.test(newKey)} onClick={() => { onChange(newKey, 'None'); setNewKey(''); }}>+ kwarg</button>
      </div>
    </section>
  );
}

/** Class whose methods a chain on `name` calls: the object's constructor class, or a sensible base. */
function useChainClass(name: string | undefined): string {
  const obj = useStore((s) => s.doc.objects.find((o) => o.name === name));
  if (name === 'self.camera.frame') return 'ScreenRectangle';
  if (obj && /^[A-Za-z_]\w*$/.test(obj.ctor)) return obj.ctor;
  return 'VMobject';
}

/** Method chain as editable call cards, each with the method's real signature. */
function ChainEditor({ chain, cls, onChange, title, placeholder, help }: { chain: string; cls: string; onChange: (v: string) => void; title: string; placeholder: string; help?: TipContent }) {
  const sig = useSignature(cls);
  const common = useStore((s) => s.catalog?.methods) ?? [];
  const [raw, setRaw] = useState(false);
  const calls = parseChain(chain);
  const methods = sig?.methods ?? common;
  const top = methods.filter((m) => common.includes(m));
  const rest = methods.filter((m) => !common.includes(m));
  const write = (next: Call[]) => onChange(formatChain(next));
  return (
    <section>
      <h4>
        {help ? <Tip tip={help}>{title}</Tip> : title}{' '}
        <select className="inline" aria-label="Add a method call" value="" onChange={(e) => e.target.value && write([...(calls ?? []), { name: e.target.value, args: '' }])} disabled={!calls}>
          <option value="">+ method</option>
          <optgroup label="Common">{top.map((m) => <option key={m}>{m}</option>)}</optgroup>
          <optgroup label={`All ${cls} methods`}>{rest.map((m) => <option key={m}>{m}</option>)}</optgroup>
        </select>
        <span className="spacer" />
        <button className={`raw-toggle ${raw || !calls ? 'on' : ''}`} disabled={!calls} title={calls ? 'Edit as Python' : 'This chain is custom Python'} onClick={() => setRaw(!raw)}>{'{}'}</button>
      </h4>
      {raw || !calls ? (
        <Field multiline className="mono" value={chain} placeholder={placeholder} onChange={onChange} />
      ) : (
        <>
          {calls.length === 0 && <p className="muted small">No methods. Add one from the list.</p>}
          {calls.map((c, i) => (
            <CallCard key={i} cls={cls} call={c} onChange={(nc) => write(calls.map((x, j) => (j === i ? nc : x)))}
              onRemove={() => write(calls.filter((_, j) => j !== i))}
              onUp={i > 0 ? () => write(calls.map((x, j) => (j === i - 1 ? calls[i] : j === i ? calls[i - 1] : x))) : undefined} />
          ))}
        </>
      )}
    </section>
  );
}

function CallCard({ cls, call, onChange, onRemove, onUp }: { cls: string; call: Call; onChange: (c: Call) => void; onRemove: () => void; onUp?: () => void }) {
  const sig = useSignature(`${cls}.${call.name}`);
  const [newKey, setNewKey] = useState('');
  const params = sig?.params ?? [];
  const { pos, kw } = parseArgs(call.args);
  // Map positional source onto parameters in order ("*" swallows the rest).
  const args: Args = {};
  const positional = params.filter((p) => !p.kwonly);
  let overflow = false;
  pos.forEach((src, i) => {
    const p = positional[Math.min(i, positional.length - 1)];
    if (!p || (p.name !== '*' && i >= positional.length)) overflow = true;
    else if (p.name === '*') args['*'] = args['*'] ? `${args['*']}, ${src}` : src;
    else args[p.name] = src;
  });
  for (const [k, v] of kw) args[k] = v;
  const write = (next: Args) => {
    const out: string[] = [];
    const star = params.findIndex((p) => p.name === '*');
    let i = 0;
    // Leading required (or pre-*args) parameters stay positional, the rest become keywords.
    for (; i < positional.length; i++) {
      const p = positional[i];
      if (p.name === '*') { if (next['*']) out.push(next['*']); i++; break; }
      const v = next[p.name];
      if (star > i && next['*']) { out.push(v || p.default || 'None'); continue; }
      if (!v || !p.required) break;
      out.push(v);
    }
    const done = new Set(positional.slice(0, i).map((p) => p.name));
    for (const [k, v] of Object.entries(next)) if (v && k !== '*' && !done.has(k)) out.push(`${k}=${v}`);
    onChange({ name: call.name, args: out.join(', ') });
  };
  const set = (k: string, v: string) => {
    const next = { ...args };
    if (v.trim()) next[k] = v;
    else delete next[k];
    write(next);
  };
  const known = new Set(params.map((p) => p.name));
  return (
    <div className="call-card">
      <div className="call-head">
        <span className="mono">.{call.name}</span>
        <span className="spacer" />
        {onUp && <button className="x-btn" title="Move up" onClick={onUp}>↑</button>}
        <button className="x-btn" title="Remove" onClick={onRemove}>×</button>
      </div>
      {sig?.doc && <p className="doc small">{sig.doc}</p>}
      {!sig || sig.unknown || overflow ? (
        <Field className="mono" value={call.args} placeholder="arguments" onChange={(v) => onChange({ name: call.name, args: v })} />
      ) : (
        <>
          {params.map((p) => <ParamField key={p.name} param={p} value={args[p.name] ?? ''} siblings={args} onChange={(v) => set(p.name, v)} />)}
          {Object.keys(args).filter((k) => !known.has(k)).map((k) => (
            <ParamField key={k} param={{ name: k, label: k, kind: 'expr', default: '', required: false, annotation: '', from: '' }} value={args[k]} onChange={(v) => set(k, v)} onRemove={() => set(k, '')} />
          ))}
          <div className="row">
            <input className="field mono" placeholder="other_kwarg" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            <button className="ghost small" disabled={!/^\w+$/.test(newKey)} onClick={() => { set(newKey, 'None'); setNewKey(''); }}>+ kwarg</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Hover help for the clip settings that aren't manim arguments. */
const CLIP_HELP: Record<string, TipContent> = {
  cls: { title: 'Animation', text: 'The manim animation this clip plays. Type or pick another class to switch to it. Arguments the new class doesn’t take must be removed below, or the clip shows an error.' },
  eol: { title: 'Comment at the end of the line', text: 'Written after the statement on its line, as the code had it: self.play(...)  # the reveal.' },
  blockHead: { title: 'Header', text: 'The line that opens the block, without its colon: for d in dots, while k < 3, if k > 2, with …, try. Its steps on the timeline are its body.' },
  repeat: { title: 'Repeat', text: 'How many times the loop runs (range(n)): its steps play again each time.' },
  assignTarget: { title: 'Name', text: 'What gets the value: a variable (k), an attribute (self.count) or an item (values[0]). Several names unpack a tuple (a, b).' },
  assignValue: { title: 'Value', text: 'Any Python expression. It is worked out when the scene runs, at this point in it.' },
  addExpr: { title: 'Expressions', text: 'Anything else the statement passes: *dots spreads a list, VGroup(a, b) builds a group on the spot.' },
  exprSrc: { title: 'Animation code', text: 'An animation written as an expression manim works out when the scene runs: a list of animations (*[FadeIn(d) for d in dots]), a function call, a variable. Its length is measured by running the scene.' },
  target: { title: 'Object', text: 'The object this clip animates. Pick another object’s name to animate that one instead; the timing stays the same.' },
  start: {
    title: 'Start',
    text: 'When it begins, measured by manim. A statement starts when the one before it ends, and the animations of a self.play start together (inside AnimationGroup, LaggedStart and Succession, when the group starts them). Drag the clip on the timeline to move it.',
  },
  duration: {
    title: 'Duration',
    text: 'How long the animation takes (manim’s run_time). Longer is slower: the same change is spread over more time. The self.play lasts as long as its longest animation, and everything after it moves along; with Keep later timing on (a button by the timeline’s snap magnet), the pause right after it gives or takes the time instead.',
    notes: ['Same as dragging the clip’s right edge on the timeline.', 'A run_time on the self.play applies to all its animations; changing one of several gives the others that run_time as their own.'],
  },
  holdDuration: { title: 'Duration', text: 'How long the scene keeps running here (self.wait). Nothing moves except objects with updaters. Use it to pause, or to extend the end of the video.' },
  glide: { title: 'Glide', text: 'How long the objects take to move back into their constructed place or shape. 0 snaps them back at once.', notes: ['While gliding, the target keeps updating, so it lands where the relationship is at the end.'] },
  measured: { title: 'Measured', text: 'Code lasts as long as the self.play and self.wait calls inside it take; this is measured by running the scene. Edit the code to change it.' },
  enabled: { title: 'Enabled', text: 'Unticked, it is left out of the code, so the preview and the exported video skip it. It stays in the project, so you can compare with and without it.', notes: ['Shift+E toggles the selected clips.'] },
  methods: {
    title: 'Methods to animate',
    text: 'Each method is applied to the object, and the clip animates it from how it is when the clip starts to how it is after these calls. Changing a method’s arguments changes where the object ends up. Calls run in order, top to bottom.',
  },
  easing: {
    title: 'Easing',
    text: 'How the change is spread over the clip’s time: at a constant speed, starting or ending slowly, or going there and back. The clip’s curve (or its intro and outro ramp) on the timeline shows it.',
    notes: ['Sets manim’s rate_func. Every rate function manim has is in the arguments below.'],
  },
  channels: {
    title: 'Keyframes',
    text: 'Each property of the object at the playhead. ◆ adds a keyframe there (an animation that ends at the playhead) or removes the one there. Changing a value changes the keyframe under the playhead, or adds one; with no keyframes yet it changes the object as created.',
    notes: ['A keyframe is plain manim code: obj.animate.move_to(…), .scale(…), .set_color(…), Rotate(obj, angle=…), tracker.animate.set_value(…). Editing one changes only that argument, in the way it was written.', 'Keyframes placed relative to something else (next_to, to_edge…) or written as expressions are shown but edited in the code.'],
  },
  keyframes: {
    title: 'Keyframes',
    text: 'Where this object’s animations start and end, across the whole scene; this clip’s are highlighted. ◀ ▶ move the playhead to the previous or next one; click a diamond to go there and select its animation.',
  },
  label: { title: 'Label', text: 'The name shown on the clip in the timeline. It doesn’t change the scene.' },
  comment: { title: 'Comment', text: 'Comment lines written above this statement in the code (# …). They don’t change the scene.' },
};

const PLAY_RUN_TIME = 'self.play(..., run_time=…) sets the run_time of every animation in it. Leave it empty to let each animation keep its own.';

function setStep(id: string, fn: (s: Step) => void, key: string) {
  updateDoc((d) => {
    const s = findStep(d, id);
    if (s) fn(s);
  }, `${id}:${key}`);
}

function setAnim(id: string, fn: (a: Anim) => void, key: string) {
  updateDoc((d) => {
    const a = findAnim(d, id)?.anim;
    if (a) fn(a);
  }, `${id}:${key}`);
}

const frames = (v: number) => Math.round(v * fps()) / fps();

/** Set a length from Effect Controls the way trimming its clip does (Keep later timing included). */
function setLength(target: { anim: string } | { step: string }, v: number, key: string) {
  const { timeline, keepTiming } = getState();
  let limit: string | undefined;
  updateDoc((d) => void (limit = retime(d, timeline, target, frames(v), keepTiming).limit), key);
  if (limit) toast(limit);
}

function TimingRow({ id, step }: { id: string; step: boolean }) {
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const sp = (step ? lay.steps : lay.anims).get(id);
  if (!sp) return null;
  return (
    <div className="fx-row"><Tip tip={CLIP_HELP.start}>Runs</Tip><span className="mono small">{timecode(sp.start)} → {timecode(sp.end)}</span><span className="muted small">{(sp.end - sp.start).toFixed(2)}s{sp.estimated ? ' (estimate)' : ''}</span></div>
  );
}

function EnabledRow({ id, disabled }: { id: string; disabled?: boolean }) {
  return <label className="check"><input type="checkbox" checked={!disabled} onChange={() => toggleDisabled([id])} /> <Tip tip={CLIP_HELP.enabled}>enabled</Tip></label>;
}

function CommentField({ step }: { step: Step }) {
  return (
    <label className="param"><span className="pname"><Tip tip={CLIP_HELP.comment}>comment</Tip></span>
      <Field multiline className="mono" value={step.comment ?? ''} placeholder="# what this does" onChange={(v) => setStep(step.id, (s) => {
        if (v.trim()) s.comment = v.split('\n').map((l) => (l.trim() && !l.trim().startsWith('#') ? `# ${l.trim()}` : l.trim())).join('\n');
        else delete s.comment;
      }, 'comment')} />
    </label>
  );
}

/** The comment at the end of a step's line in the code (`self.play(...)  # the reveal`). */
function EolField({ step }: { step: Step }) {
  return (
    <label className="param"><span className="pname"><Tip tip={CLIP_HELP.eol}>line end</Tip></span>
      <Field className="mono" value={step.eol ?? ''} placeholder="# at the end of its line" ariaLabel="Comment at the end of its line" onChange={(v) => setStep(step.id, (s) => {
        if (v.trim()) s.eol = v.trim().startsWith('#') ? v.trim() : `# ${v.trim()}`;
        else delete s.eol;
      }, 'eol')} />
    </label>
  );
}

/** An apply step: methods called on an object at once (`label.next_to(u, UP)`), and that object's keyframes. */
function ApplySection({ step }: { step: Step }) {
  const target = step.target ?? '';
  const obj = useStore((s) => s.doc.objects.find((o) => o.name === target));
  const cls = useChainClass(obj ? obj.name : target);
  return (
    <>
      <section>
        <p className="muted small">The methods run here, between the statements around it: the object changes at once, with no animation (a jump in its keyframes).</p>
        <label className="param"><span className="pname"><Tip tip={CLIP_HELP.target}>Object</Tip></span>
          <Field className="mono" value={target} list="me-targets" ariaLabel="Object" onChange={(v) => setStep(step.id, (s) => void (s.target = v), 'target')} />
        </label>
      </section>
      <ChainEditor title="Methods" help={CLIP_HELP.methods} cls={cls} chain={step.chain ?? ''} placeholder=".next_to(other, UP)" onChange={(v) => setStep(step.id, (s) => void (s.chain = v), 'chain')} />
      {obj && <KeyframeChannels obj={obj} clip={step.id} />}
      {!obj && target.trim() === CAMERA_NAME && <KeyframeChannels obj={CAMERA} clip={step.id} />}
    </>
  );
}

const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '@=', '|=', '&=', '^=', '<<=', '>>='];

/** An assign step: `target op value`, a variable (or an attribute, an item…) later statements read. */
function AssignSection({ step }: { step: Step }) {
  const op = step.op ?? '=';
  return (
    <section>
      <p className="muted small">Runs here, between the statements around it, and takes no time. Steps after it can use the value.</p>
      <label className="param"><span className="pname"><Tip tip={CLIP_HELP.assignTarget}>Name</Tip></span>
        <Field className="mono" value={step.target ?? ''} ariaLabel="Name" onChange={(v) => setStep(step.id, (s) => void (s.target = v), 'target')} />
      </label>
      <label className="param"><span className="pname">Operation</span>
        <select className="field mono" aria-label="Operation" value={op} onChange={(e) => setStep(step.id, (s) => void (s.op = e.target.value), 'op')}>
          {(ASSIGN_OPS.includes(op) ? ASSIGN_OPS : [op, ...ASSIGN_OPS]).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <h4><Tip tip={CLIP_HELP.assignValue}>Value</Tip></h4>
      <CodeArea value={step.value ?? ''} minLines={1} onChange={(v) => setStep(step.id, (s) => void (s.value = v), 'value')} />
    </section>
  );
}

const REPEAT = /^\s*for\s+(\w+)\s+in\s+range\(\s*(\d+)\s*\)\s*$/;

/** A block step: the header of a compound statement (for, while, if, with, try…), how many times its body ran, and
 * its clauses. The steps between it and its end are its body: they run each time it does. */
function BlockSection({ step }: { step: Step }) {
  const doc = useStore((s) => s.doc);
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const opener = compoundOf(doc.timeline, step.id) ?? step.id;
  const shape = compounds(doc.timeline).get(opener);
  const b = lay.blocks.find((x) => x.id === opener);
  const head = step.head ?? '';
  const rep = head.match(REPEAT);
  const clause = b?.clauses.find((c) => c.id === step.id);
  const runs = clause && clause.id !== opener ? clause.runs : b?.runs;
  const kinds = doc.timeline.filter((x) => x.id === opener || shape?.clauses.includes(x.id)).map((x) => (x.head ?? '').trim().split(/\s/)[0]);
  const canElse = ['for', 'while', 'if', 'elif', 'except'].includes(kinds[kinds.length - 1]) && !(kinds[0] === 'try' && kinds.includes('finally'));
  const addClause = (h: string) => updateDoc((d) => {
    const c = compounds(d.timeline).get(opener);
    if (!c?.end) return;
    d.timeline.splice(d.timeline.findIndex((x) => x.id === c.end), 0, { id: uid('s'), kind: 'block', head: h });
  });
  return (
    <section>
      {step.kind === 'end'
        ? <p className="muted small">The end of the block: the steps after it run once the block is done.</p>
        : <p className="muted small">{isClause(step) ? 'This clause’s steps run when the code reaches it.' : 'The steps under it on the timeline, up to its end, are its body: they run each time it does.'}{' '}
          {runs !== undefined ? (runs === 0 ? 'Its body didn’t run.' : `Its body ran ${runs} time${runs === 1 ? '' : 's'}${b?.estimated ? ' (estimated)' : ''}.`) : ''}</p>}
      {step.kind === 'block' && (
        <>
          <label className="param"><span className="pname"><Tip tip={CLIP_HELP.blockHead}>Header</Tip></span>
            <Field className="mono" value={head} ariaLabel="Header" onChange={(v) => setStep(step.id, (s) => void (s.head = v.replace(/:\s*$/, '')), 'head')} />
          </label>
          {rep && (
            <div className="fx-row"><Tip tip={CLIP_HELP.repeat}>Repeat</Tip>
              <ScrubNumber value={+rep[2]} min={0} step={1} precision={0} suffix="×" onChange={(v) => setStep(step.id, (s) => void (s.head = `for ${rep[1]} in range(${Math.max(0, Math.round(v))})`), 'head')} />
            </div>
          )}
        </>
      )}
      <div className="row">
        {step.id !== opener && <button className="ghost small" onClick={() => selectClips([opener])}>Select the block</button>}
        {!isClause(step) && canElse && shape?.end && <button className="ghost small" title="Add an else: steps that run when the block’s own don’t (or after a loop that wasn’t broken out of)" onClick={() => addClause('else')}>+ else</button>}
        {kinds[0] === 'if' && !kinds.includes('else') && shape?.end && <button className="ghost small" title="Add an elif: another condition, tried when the ones before it are false" onClick={() => addClause('elif True')}>+ elif</button>}
        <button className="ghost small" title="Take its steps out of the block: they run once, in place (other clauses go with their steps)" onClick={() => unwrapBlock(step.id)}>Unwrap</button>
      </div>
    </section>
  );
}

/** Targets of self.add / self.remove that aren't object names (`*dots`, `VGroup(a, b)`): each one an expression. */
function ExtraTargets({ step, names }: { step: Step; names: Set<string> }) {
  const targets = step.targets ?? [];
  const set = (i: number, v: string | null) => setStep(step.id, (s) => {
    const t = [...(s.targets ?? [])];
    if (v === null) t.splice(i, 1);
    else if (i >= t.length) t.push(v);
    else t[i] = v;
    s.targets = t;
  }, 'targets:' + i);
  return (
    <>
      <h4><Tip tip={CLIP_HELP.addExpr}>Expressions</Tip></h4>
      {targets.map((t, i) => names.has(t) ? null : (
        <div key={i} className="row">
          <Field className="mono" value={t} ariaLabel={`Expression ${i + 1}`} onChange={(v) => set(i, v)} />
          <button className="x-btn" title="Remove it" aria-label={`Remove ${t}`} onClick={() => set(i, null)}>×</button>
        </div>
      ))}
      <div className="row"><button className="ghost small" title="Add an expression (*dots, VGroup(a, b), group[0]…)" onClick={() => set(targets.length, 'VGroup()')}>+ expression</button></div>
    </>
  );
}

/** Effect Controls of a statement: self.play, self.wait, self.add / self.remove, any other scene method, code, couple / uncouple. */
function StepInspector({ step }: { step: Step }) {
  const objects = useStore((s) => s.doc.objects);
  const base = useStore((s) => (s.catalog ? sceneBase(s.doc) : 'Scene'));
  const playSig = useSignature(step.kind === 'play' ? `${base}.play` : '');
  const animationSig = useSignature(step.kind === 'play' ? 'Animation' : '');
  const waitSig = useSignature(step.kind === 'wait' ? `${base}.wait` : '');
  const callSig = useSignature(step.kind === 'call' && step.method ? `${base}.${step.method}` : '');
  const calls = useStore((s) => s.catalog?.scene_methods?.[base]);
  const label = stepLabel(step);
  const toggleTarget = (name: string, on: boolean) => setStep(step.id, (s) => {
    const t = s.targets ?? [];
    s.targets = on ? [...t, name] : t.filter((x) => x !== name);
  }, 'targets');
  const setArgs = (k: string, v: string) => setStep(step.id, (s) => setArg((s.args ??= {}), k, v), 'arg:' + k);
  const waitLen = step.kind === 'wait' ? literal(step.args?.duration ?? '1') : undefined;
  // self.play's own options, then what it passes to every animation (manim sets them on each one).
  const playParams = [
    ...(animationSig?.params ?? []).map((p) => (p.name === 'run_time' ? { ...p, doc: PLAY_RUN_TIME } : p)),
    ...(playSig?.params ?? []).filter((p) => p.name !== '*').map((p) => ({ ...p, from: '' })),
  ].map((p) => ({ ...p, from: ['run_time', 'rate_func', 'lag_ratio'].includes(p.name) ? '' : p.name.startsWith('subcaption') ? 'subcaption' : 'every animation' }));
  return (
    <div className="pad">
      <h3>{{ play: 'Play together', wait: 'Pause', add: 'Add', remove: 'Remove', code: 'Code', couple: 'Couple', uncouple: 'Uncouple', apply: 'Change at once', assign: 'Value', block: isClause(step) ? 'Clause' : 'Block', end: 'End of block' }[step.kind as string] ?? `self.${step.method}(…)`}</h3>
      {step.kind !== 'code' && <p className="muted small mono code-line">{label.title}</p>}
      {step.kind === 'call' && callSig?.doc && <p className="doc">{callSig.doc}</p>}
      <Diagnostics id={step.id} />
      <section className="fx-section">
        <h4>Timing</h4>
        <TimingRow id={step.id} step />
        {waitLen !== undefined && (
          <div className="fx-row"><Tip tip={CLIP_HELP.holdDuration}>Duration</Tip><ScrubNumber value={waitLen} min={1 / fps()} step={1 / fps()} precision={3} suffix="s" onChange={(v) => setLength({ step: step.id }, v, `${step.id}:dur`)} /></div>
        )}
        {step.kind === 'couple' && <div className="fx-row"><Tip tip={CLIP_HELP.glide}>Glide</Tip><ScrubNumber value={step.duration ?? 0} min={0} step={1 / fps()} precision={3} suffix="s" onChange={(v) => setStep(step.id, (s) => { const g = Math.max(0, frames(v)); if (g) s.duration = g; else delete s.duration; }, 'dur')} /><span className="muted small">{step.duration ? '' : 'snaps at once'}</span></div>}
        {(step.kind === 'code' || step.kind === 'call') && <p className="muted small"><Tip tip={CLIP_HELP.measured}>How long it runs</Tip> is measured by running the scene.</p>}
        <EnabledRow id={step.id} disabled={step.disabled} />
      </section>

      {step.kind === 'play' && (
        <>
          <AnimationsList parentId={step.id} anims={step.anims ?? []} title="Animations (played together)" rows />
          <ArgsEditor title="self.play arguments (for every animation)" params={playParams} args={step.args ?? {}} onChange={setArgs} />
        </>
      )}
      {step.kind === 'wait' && <ArgsEditor title="self.wait arguments" params={waitSig?.params ?? []} args={step.args ?? {}} onChange={setArgs} />}
      {step.kind === 'call' && (
        <>
          <section>
            <h4>Method</h4>
            <select className="field mono" aria-label="Scene method" value={step.method} onChange={(e) => setStep(step.id, (s) => { s.method = e.target.value; s.args = {}; delete s.positional; }, 'method')}>
              {(calls ?? []).filter((m) => !['play', 'wait', 'add', 'remove'].includes(m)).map((m) => <option key={m} value={m}>self.{m}</option>)}
              {step.method && !calls?.includes(step.method) && <option value={step.method}>self.{step.method}</option>}
            </select>
          </section>
          <ArgsEditor params={callSig?.params ?? []} args={step.args ?? {}} onChange={setArgs} />
        </>
      )}

      {step.kind === 'code' && (
        <section>
          <label className="param"><span className="pname"><Tip tip={CLIP_HELP.label}>label</Tip></span><Field value={step.label ?? ''} placeholder="code" onChange={(v) => setStep(step.id, (s) => { if (v) s.label = v; else delete s.label; }, 'label')} /></label>
          <p className="muted small">Runs inside <code>construct(self)</code> here. Every object variable is in scope, and <code>self.play</code> calls here take their own time.</p>
          <CodeArea value={step.code ?? ''} minLines={4} onChange={(v) => setStep(step.id, (s) => void (s.code = v), 'code')} />
        </section>
      )}

      {step.kind === 'apply' && <ApplySection step={step} />}
      {step.kind === 'assign' && <AssignSection step={step} />}
      {(step.kind === 'block' || step.kind === 'end') && <BlockSection step={step} />}

      {(step.kind === 'add' || step.kind === 'remove') && (
        <section>
          <p className="muted small">{step.kind === 'add' ? 'Ticked objects appear on screen here, without an animation (drawn in this order, on top of what is there).' : 'Ticked objects disappear here, without an animation.'}</p>
          {objects.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={step.targets?.includes(o.name) ?? false} onChange={(e) => toggleTarget(o.name, e.target.checked)} />
              <span className="mono">{o.name}</span>
            </label>
          ))}
          <ExtraTargets step={step} names={new Set(objects.map((o) => o.name))} />
        </section>
      )}

      {(step.kind === 'couple' || step.kind === 'uncouple') && (
        <section>
          <p className="muted small">{step.kind === 'uncouple'
            ? 'From here, ticked objects stop following their relationships: they stay where they are and can be animated freely.'
            : 'From here, ticked objects follow their relationships again. With a glide they move back into place over that time; without one they snap.'}</p>
          {objects.filter((o) => o.link).map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={step.targets?.includes(o.name) ?? false} onChange={(e) => toggleTarget(o.name, e.target.checked)} />
              <span className="mono">{o.name}</span>
            </label>
          ))}
          {!objects.some((o) => o.link) && <p className="muted small">No object has a relationship yet.</p>}
        </section>
      )}

      <section><CommentField step={step} />{step.kind !== 'code' && step.kind !== 'end' && <EolField step={step} />}</section>
      <ClipActions id={step.id} />
    </div>
  );
}

/** The animations of a self.play or a composition: select, reorder, switch off, remove, add, group. */
function AnimationsList({ parentId, anims, title, rows }: { parentId: string; anims: Anim[]; title: string; rows?: boolean }) {
  const catalog = useStore((s) => s.catalog);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const [groupCls, setGroupCls] = useState('');
  const selected = selection?.kind === 'clips' ? anims.filter((a) => selection.ids.includes(a.id)).map((a) => a.id) : [];
  const groups = (catalog?.animations ?? []).filter((e) => e.category === 'Composition' && !e.name.endsWith('Map')).map((e) => e.name);
  const add = (cls: string) => {
    const s = getState();
    const sel = s.selection?.kind === 'object' ? s.doc.objects.find((o) => o.id === (s.selection as { id: string }).id) : undefined;
    const target = sel?.name ?? anims.map((a) => a.target).find(Boolean) ?? doc.objects[doc.objects.length - 1]?.name ?? '';
    const a = newAnim(cls, target);
    updateDoc((d) => addChild(d, parentId, a));
    selectClips([a.id]);
  };
  return (
    <section>
      <h4>{title}</h4>
      {anims.map((a, i) => (
        <div key={a.id} className={`anim-row ${a.disabled ? 'off' : ''}`}>
          {rows && <span className="muted">V{i + 1}</span>}
          <button className="ghost mono anim-name" onClick={() => selectClips([a.id])} title="Select it">{animLabel(a).title}</button>
          <input type="checkbox" checked={!a.disabled} title="enabled" onChange={() => toggleDisabled([a.id])} />
          <button className="x-btn" disabled={i === 0} title="Earlier in the list" onClick={() => updateDoc((d) => reorder(d, a.id, -1))}>↑</button>
          <button className="x-btn" disabled={i === anims.length - 1} title="Later in the list" onClick={() => updateDoc((d) => reorder(d, a.id, 1))}>↓</button>
          <button className="x-btn" title="Remove it" onClick={() => updateDoc((d) => removeIds(d, docLayout(), new Set([a.id]), 'lift'))}>×</button>
        </div>
      ))}
      <div className="row">
        <select className="field mono" aria-label="Add an animation" value="" onChange={(e) => e.target.value && add(e.target.value)} title="Add an animation here (it targets the selected object)">
          <option value="">+ animation…</option>
          <option value="animate">.animate</option>
          {(catalog?.animations ?? []).map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
        </select>
      </div>
      {anims.length > 1 && (
        <div className="row">
          <select className="field mono" aria-label="Group animations into" value={groupCls} onChange={(e) => setGroupCls(e.target.value)}>
            <option value="">Group {selected.length > 1 ? `${selected.length} selected` : 'all'} into…</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <button className="ghost small" disabled={!groupCls} title="Put them in one composition: they play as one animation with its lag_ratio, rate_func…"
            onClick={() => {
              let id: string | null = null;
              updateDoc((d) => void (id = groupAnims(d, selected.length > 1 ? selected : anims.map((a) => a.id), groupCls)));
              if (id) selectClips([id]);
              setGroupCls('');
            }}>Group</button>
        </div>
      )}
    </section>
  );
}

function ClipActions({ id }: { id: string }) {
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const sp = lay.steps.get(id) ?? lay.anims.get(id);
  return (
    <div className="row actions">
      <button title="Move the playhead to where this ends, to see its result" onClick={() => sp && setState({ time: frameSnap(sp.end), showVideo: false })}>Go to end</button>
      <button title="Show it in the code" onClick={() => setState({ centerTab: 'code' })}>Show code</button>
      <button className="danger" title="Remove it (Delete) and leave its time as a pause; Shift+Delete closes the gap" onClick={() => deleteSelection()}>Delete</button>
    </div>
  );
}

/** Effect Controls of one animation (in a self.play, or inside a composition): every argument of its manim class. */
function AnimInspector({ r }: { r: AnimRef }) {
  const { anim, step, parent } = r;
  const isAnimate = anim.cls === 'animate';
  const plain = !isAnimate && anim.cls !== 'TransformTerms';
  const sig = useSignature(plain ? anim.cls : isAnimate ? 'animate' : '');
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const sp = lay.anims.get(anim.id);
  const targetCls = useChainClass(anim.target);
  const targetObj = useStore((s) => s.doc.objects.find((o) => o.name === anim.target));
  const composition = !!anim.anims;
  const rt = literal(anim.args.run_time ?? (!parent ? step.args?.run_time : undefined));
  const target = sig?.target;
  const showTarget = !composition && (!target || target.kind === 'mobject' || target.kind === 'mobjects' || anim.target);
  const list = parent?.anims ?? step.anims ?? [];
  const at = list.indexOf(anim);
  const setTarget = (v: string) => setAnim(anim.id, (a) => void (a.target = v), 'target');
  if (anim.cls === 'expr') return <ExprAnimInspector r={r} />;
  return (
    <div className="pad">
      <div className="insp-head">
        <Tip tip={CLIP_HELP.cls}><Field className="mono" value={anim.cls} list="me-animations" onChange={(v) => setAnim(anim.id, (a) => { a.cls = v; delete a.positional; }, 'cls')} /></Tip>
      </div>
      {sig?.doc && <p className="doc">{sig.doc}</p>}
      <Diagnostics id={anim.id} />
      {showTarget && (
        <section>
          <h4><Tip tip={CLIP_HELP.target}>{target?.kind === 'mobjects' ? 'Objects' : 'Object'}</Tip></h4>
          {target && (target.kind === 'mobject' || target.kind === 'mobjects')
            ? <ParamField param={{ ...(target as Param), name: target.kind === 'mobjects' ? '*' : 'target', label: 'animates' }} value={anim.target} onChange={setTarget} />
            : <Field className="mono" value={anim.target} list="me-targets" onChange={setTarget} />}
        </section>
      )}

      <section className="fx-section">
        <h4>Timing</h4>
        <TimingRow id={anim.id} step={false} />
        <div className="fx-row"><Tip tip={CLIP_HELP.duration}>Duration</Tip>
          <ScrubNumber value={rt ?? (sp ? sp.end - sp.start : 1)} min={1 / fps()} step={1 / fps()} precision={3} suffix="s" onChange={(v) => setLength({ anim: anim.id }, v, `${anim.id}:dur`)} />
          {anim.args.run_time === undefined && <span className="muted small">{!parent && step.args?.run_time !== undefined ? `self.play’s run_time=${step.args.run_time}${(step.anims ?? []).length > 1 ? `, shared by all ${(step.anims ?? []).length}` : ''}` : 'manim’s default'}</span>}
        </div>
        <div className="fx-row"><span>In</span>
          <button className="ghost small mono" onClick={() => selectClips([parent?.id ?? step.id])} title="Select it">{parent ? parent.cls : 'self.play'}</button>
          <span className="muted small">{parent ? `#${at + 1} of ${list.length}` : `V${at + 1}`}</span>
          <button className="x-btn" disabled={at <= 0} title="Earlier" onClick={() => updateDoc((d) => reorder(d, anim.id, -1))}>↑</button>
          <button className="x-btn" disabled={at >= list.length - 1} title="Later" onClick={() => updateDoc((d) => reorder(d, anim.id, 1))}>↓</button>
        </div>
        <EaseRow anim={anim} step={step} nested={!!parent} def={sig?.params.find((p) => p.name === 'rate_func')?.default} />
        <KeyframesRow anim={anim} />
        <EnabledRow id={anim.id} disabled={anim.disabled} />
      </section>
      {targetObj && <KeyframeChannels obj={targetObj} clip={anim.id} />}
      {!targetObj && anim.target.trim() === CAMERA_NAME && <KeyframeChannels obj={CAMERA} clip={anim.id} />}

      {composition && (
        <>
          <AnimationsList parentId={anim.id} anims={anim.anims!} title={`Animations in this ${anim.cls}`} />
          <div className="row"><button className="ghost small" title="Replace the group by its animations (its own arguments, such as lag_ratio, are dropped)" onClick={() => { updateDoc((d) => ungroup(d, anim.id)); selectClips([step.id]); }}>Ungroup</button></div>
        </>
      )}
      {isAnimate && (
        <>
          <ChainEditor title="Methods to animate" help={CLIP_HELP.methods} cls={targetCls} chain={anim.chain ?? ''} placeholder=".shift(RIGHT * 2).rotate(PI / 2)" onChange={(v) => setAnim(anim.id, (a) => void (a.chain = v), 'chain')} />
          <ArgsEditor title=".animate(…) arguments" params={(sig?.params ?? []).filter((p) => p.name !== 'run_time')} args={anim.args} onChange={(k, v) => setAnim(anim.id, (a) => setArg(a.args, k, v), 'arg:' + k)} />
        </>
      )}
      {anim.cls === 'TransformTerms' && <TermsClipEditor anim={anim} onChange={(fn) => setAnim(anim.id, fn, 'terms')} />}
      {plain && (
        <ArgsEditor params={(sig?.params ?? []).filter((p) => p.name !== 'run_time')} args={anim.args} onChange={(k, v) => setAnim(anim.id, (a) => setArg(a.args, k, v), 'arg:' + k)} />
      )}
      <ClipActions id={anim.id} />
    </div>
  );
}

/** An animation written as an expression (`*[FadeOut(m) for m in dots]`, `make_anim(k)`): edited as code. */
function ExprAnimInspector({ r }: { r: AnimRef }) {
  const { anim, step, parent } = r;
  const list = parent?.anims ?? step.anims ?? [];
  const at = list.indexOf(anim);
  return (
    <div className="pad">
      <h3>{animLabel(anim).name === 'code' ? 'Animation code' : `${animLabel(anim).name} (code)`}</h3>
      <Diagnostics id={anim.id} />
      <section className="fx-section">
        <h4>Timing</h4>
        <TimingRow id={anim.id} step={false} />
        <p className="muted small"><Tip tip={CLIP_HELP.measured}>How long it runs</Tip> is measured by running the scene.</p>
        <div className="fx-row"><span>In</span>
          <button className="ghost small mono" onClick={() => selectClips([parent?.id ?? step.id])} title="Select it">{parent ? parent.cls : 'self.play'}</button>
          <span className="muted small">{parent ? `#${at + 1} of ${list.length}` : `V${at + 1}`}</span>
          <button className="x-btn" disabled={at <= 0} title="Earlier" onClick={() => updateDoc((d) => reorder(d, anim.id, -1))}>↑</button>
          <button className="x-btn" disabled={at >= list.length - 1} title="Later" onClick={() => updateDoc((d) => reorder(d, anim.id, 1))}>↓</button>
        </div>
        <EnabledRow id={anim.id} disabled={anim.disabled} />
      </section>
      <section>
        <h4><Tip tip={CLIP_HELP.exprSrc}>Animation code</Tip></h4>
        <CodeArea value={anim.src ?? ''} minLines={2} onChange={(v) => setAnim(anim.id, (a) => void (a.src = v), 'src')} />
      </section>
      <ClipActions id={anim.id} />
    </div>
  );
}

const EASES: [label: string, rate: string, tip: string][] = [
  ['Linear', 'linear', 'Constant speed from start to end'],
  ['Ease in', 'rush_into', 'Starts slowly and ends at full speed (rush_into)'],
  ['Ease out', 'rush_from', 'Starts at full speed and slows to a stop (rush_from)'],
  ['Ease in-out', 'smooth', 'Slow at both ends (smooth, manim’s usual easing)'],
  ['There and back', 'there_and_back', 'Goes all the way, then comes back (there_and_back)'],
];
const rateName = (v: string | undefined) => (v ?? '').trim().replace(/^rate_functions\./, '');

/** Easing presets in front of rate_func (the full list stays in the arguments below). A rate_func given to self.play
 * applies to every animation in it, so when there is one the presets change that. */
function EaseRow({ anim, step, nested, def }: { anim: Anim; step: Step; nested: boolean; def?: string }) {
  const onPlay = !nested && !!step.args?.rate_func;
  const usual = rateName(def) || 'smooth';
  const current = onPlay ? rateName(step.args!.rate_func) : rateName(anim.args.rate_func) || usual;
  const set = (v: string) =>
    onPlay
      ? setStep(step.id, (s) => setArg((s.args ??= {}), 'rate_func', v), 'arg:rate_func')
      : setAnim(anim.id, (a) => setArg(a.args, 'rate_func', v === usual ? '' : v), 'arg:rate_func');
  const known = EASES.some(([, r]) => r === current);
  return (
    <>
      <div className="fx-row ease-row"><Tip tip={CLIP_HELP.easing}>Easing</Tip>
        <div className="seg ease" role="group" aria-label="Easing">
          {EASES.map(([label, rate, tip]) => (
            <button key={rate} className={current === rate ? 'on' : ''} aria-pressed={current === rate} title={tip + (rate === usual ? `\n${anim.cls}’s default` : '')} onClick={() => set(rate)}>
              <svg className="rate-icon" viewBox="0 0 24 16" aria-hidden="true"><path d={ratePath(rate, 24, 16)} /></svg>{label}
            </button>
          ))}
        </div>
      </div>
      {(!known || onPlay) && (
        <p className="muted small ease-note">
          {!known && <>Easing: <span className="mono">{current}</span>. </>}
          {onPlay && <>Set on <button className="link" onClick={() => selectClips([step.id])}>self.play</button>: it applies to every animation playing with this one.</>}
        </p>
      )}
    </>
  );
}

/** The keyframes of this animation's object(s): where each of their animations starts and ends. ◀ ▶ move the playhead
 * from one to the next; a diamond selects the animation it belongs to. */
function KeyframesRow({ anim }: { anim: Anim }) {
  const doc = useStore((s) => s.doc);
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const time = useStore((s) => s.time);
  const names = new Set(targetsOf(anim));
  if (!names.size) return null;
  const keys: { t: number; id: string }[] = [];
  for (const step of doc.timeline) {
    if (step.kind !== 'play' || step.disabled) continue;
    for (const a of walk(step.anims)) {
      if (a.anims?.length || a.disabled || !targetsOf(a).some((n) => names.has(n))) continue;
      const sp = lay.anims.get(a.id);
      if (sp) keys.push({ t: sp.start, id: a.id }, { t: sp.end, id: a.id });
    }
  }
  // in frames, as the playhead moves: a keyframe between two frames is where the playhead lands for it
  const times = [...new Set(keys.map((k) => frameSnap(k.t)))].sort((a, b) => a - b);
  const half = 0.5 / fps();
  const prev = [...times].reverse().find((t) => t < time - half);
  const next = times.find((t) => t > time + half);
  const go = (t: number | undefined) => t !== undefined && setState({ time: frameSnap(t), showVideo: false });
  const end = Math.max(lay.end, EPS);
  const who = [...names].join(', ');
  return (
    <div className="fx-row kf-row"><Tip tip={CLIP_HELP.keyframes}>Keyframes</Tip>
      <button className="x-btn" disabled={prev === undefined} title={`Previous keyframe of ${who}`} aria-label={`Previous keyframe of ${who}`} onClick={() => go(prev)}>◀</button>
      <div className="kf-strip" aria-label={`Keyframes of ${who}`}>
        <i className="kf-now" style={{ left: `${(Math.min(time, end) / end) * 100}%` }} />
        {keys.map((k, i) => (
          <button key={i} className={`kf-dot ${k.id === anim.id ? 'mine' : ''}`} style={{ left: `${(k.t / end) * 100}%` }}
            title={`${timecode(k.t)}: ${i % 2 ? 'end' : 'start'} of ${animLabel(findAnim(doc, k.id)!.anim).title}`}
            aria-label={`${i % 2 ? 'End' : 'Start'} at ${timecode(k.t)}`}
            onClick={() => { go(k.t); if (k.id !== anim.id) selectClips([k.id]); }} />
        ))}
      </div>
      <button className="x-btn" disabled={next === undefined} title={`Next keyframe of ${who}`} aria-label={`Next keyframe of ${who}`} onClick={() => go(next)}>▶</button>
    </div>
  );
}

/**
 * Run a keyframe edit: tried on a copy first, so one that can't be done changes nothing and says why.
 */
function kfEdit(fn: (d: SceneDoc) => string | null, coalesce?: string) {
  const err = fn(structuredClone(getState().doc));
  if (err) return void toast(err);
  updateDoc((d) => void fn(d), coalesce);
}

const showColor = (v: KeyValue | undefined) => (typeof v === 'string' ? (v.startsWith('#') ? `"${v}"` : v) : '');

/**
 * One row per channel (position, scale, rotation, opacity, colour; a ValueTracker's value) of an object, at the
 * playhead. ◆ adds or removes a keyframe there; the value edits the keyframe under the playhead, else adds one (or,
 * with no keyframes yet, sets the value as created). Every keyframe is a plain manim clip, so this writes
 * `obj.animate.move_to(...)`, `.scale(...)`, `Rotate(...)`… and nothing else.
 */
function KeyframeChannels({ obj, clip }: { obj: SceneObject; clip?: string }) {
  const doc = useStore((s) => s.doc);
  const measured = useStore((s) => s.timeline);
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const time = useStore((s) => s.time);
  const info = useStore((s) => s.frame?.objects.find((o) => o.id === obj.id));
  const live = useStore((s) => s.frame?.values?.[obj.name]);
  const keys = keyframes(doc, lay, measured, obj.name);
  const half = 0.5 / fps();
  const end = Math.max(lay.end, EPS);
  const go = (t: number | undefined) => t !== undefined && setState({ time: frameSnap(t), showVideo: false });
  const fixed = ownsPosition(obj) || isFollow(obj);
  const redraw = isRedraw(obj);

  /** Write `v` into the channel at the playhead. */
  const write = (ch: Channel, v: KeyValue) =>
    kfEdit((d) => {
      const tl = getState().timeline;
      const lay2 = layout(d, tl);
      const own = keyframes(d, lay2, tl, obj.name).filter((k) => k.channel === ch);
      const on = own.find((k) => Math.abs(frameSnap(k.t) - time) < half);
      if (on) return setKeyValue(d, lay2, tl, on, v);
      if (!own.length && obj !== CAMERA) {
        const o = d.objects.find((x) => x.id === obj.id);
        if (!o) return 'The object is gone';
        setBaseValue(o, ch, v);
        return null;
      }
      const r = addKey(d, tl, obj.name, ch, time, v);
      return 'error' in r ? r.error : null;
    }, `kf:${obj.id}:${ch}:${time}`);

  return (
    <section className="fx-section kf-channels">
      <h4><Tip tip={CLIP_HELP.channels}>Keyframes of</Tip> <span className="mono kf-name">{obj.name}</span> <span className="muted small mono">{timecode(time)}</span></h4>
      {channelsOf(obj).map((ch) => {
        const meta = CHANNELS.find((c) => c.id === ch)!;
        const own = keys.filter((k) => k.channel === ch);
        const times = [...new Set(own.map((k) => frameSnap(k.t)))].sort((a, b) => a - b);
        const prev = [...times].reverse().find((t) => t < time - half);
        const next = times.find((t) => t > time + half);
        const on = own.find((k) => Math.abs(frameSnap(k.t) - time) < half);
        let value: KeyValue | undefined = on?.value;
        if (value === undefined && ch === 'position' && info?.center) value = [info.center[0], info.center[1]];
        if (value === undefined && ch === 'value' && typeof live === 'number') value = live;
        if (value === undefined) value = valueBefore(own, obj, ch, time);
        const why = redraw ? 'It is redrawn every frame (always_redraw), so animating it is overwritten: change what it is drawn from'
          : on && !on.editable ? on.why : ch === 'position' && fixed ? 'Its position comes from its construction' : undefined;
        const label = `${meta.label} of ${obj.name}`;
        const toggle = () => {
          if (on) return kfEdit((d) => deleteKey(d, layout(d, getState().timeline), on));
          if (value === undefined) return void toast(`${label} here is not known yet: set a value instead`);
          // with the value it has here; changing it right after is the same undo step
          kfEdit((d) => {
            const r = addKey(d, getState().timeline, obj.name, ch, time, value!);
            return 'error' in r ? r.error : null;
          }, `kf:${obj.id}:${ch}:${time}`);
        };
        const num = typeof value === 'number' ? value : null;
        let editor;
        const byArgs = on && !on.editable && !on.measuring && !redraw ? on : undefined; // a measurement on its way: not by arguments
        if (byArgs) editor = <span className="small kf-why" title={byArgs.why}><span className="mono">{keyCode(byArgs)}</span> <span className="muted">{fmtKey(value)}</span></span>;
        else if (why) editor = <span className="muted small kf-why" title={why}>{fmtKey(value)} <em>{why}</em></span>;
        else if (ch === 'position') {
          const p = Array.isArray(value) ? value : null;
          editor = <>
            <ScrubNumber value={p?.[0] ?? null} step={0.02} onChange={(x) => write(ch, [x, p?.[1] ?? 0])} />
            <ScrubNumber value={p?.[1] ?? null} step={0.02} onChange={(y) => write(ch, [p?.[0] ?? 0, y])} />
          </>;
        } else if (ch === 'color') editor = <ColorField value={showColor(value)} placeholder="as created" onChange={(v) => v.trim() && write(ch, v)} />;
        else if (ch === 'scale') editor = <ScrubNumber value={num} min={0.01} step={0.01} precision={3} suffix="×" onChange={(v) => write(ch, v)} />;
        else if (ch === 'rotation') editor = <ScrubNumber value={num} step={0.5} precision={1} suffix="°" onChange={(v) => write(ch, v)} />;
        else if (ch === 'opacity') editor = <ScrubNumber value={num} placeholder="1" min={0} max={1} step={0.01} onChange={(v) => write(ch, v)} />;
        else if (ch === 'stroke') editor = <ScrubNumber value={num} placeholder="as created" min={0} step={0.5} precision={2} onChange={(v) => write(ch, v)} />;
        else editor = <ScrubNumber value={num} step={0.05} precision={3} onChange={(v) => write(ch, v)} />;
        return (
          <div key={ch} className="kf-channel" data-channel={ch}>
            <div className="fx-row">
              <span>{meta.label}</span>
              <button className="x-btn" disabled={prev === undefined} title={`Previous keyframe of ${label}`} aria-label={`Previous keyframe of ${label}`} onClick={() => go(prev)}>◀</button>
              <button className={`x-btn kf-toggle ${on ? 'on' : ''}`} aria-pressed={!!on} disabled={redraw && !on} title={on ? `Remove this keyframe of ${label}` : `Add a keyframe of ${label} at ${timecode(time)}`} aria-label={on ? `Remove keyframe of ${label}` : `Add keyframe of ${label}`} onClick={toggle}>◆</button>
              <button className="x-btn" disabled={next === undefined} title={`Next keyframe of ${label}`} aria-label={`Next keyframe of ${label}`} onClick={() => go(next)}>▶</button>
              <div className="kf-value">{editor}</div>
            </div>
            {byArgs && <KeyArgs k={byArgs} label={label} />}
            {own.length > 0 && (
              <div className="kf-strip kf-lane" aria-label={`Keyframes of ${label}`}>
                <i className="kf-now" style={{ left: `${(Math.min(time, end) / end) * 100}%` }} />
                {own.map((k, i) => (
                  <button key={i} className={`kf-dot ${k.anim === clip ? 'mine' : ''} ${k.editable ? '' : 'fixed'}`} style={{ left: `${(k.t / end) * 100}%` }}
                    title={`${timecode(k.t)}: ${keyCode(k)} → ${fmtKey(k.value)}${k.editable ? '' : ` (${k.why})`}`}
                    aria-label={`${meta.label} keyframe at ${timecode(k.t)}`}
                    onClick={() => { go(k.t); if (clip && k.anim !== clip) selectClips([k.anim]); }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * A keyframe whose value is an expression or relative to something else (`.next_to(g, UP)`): its method's arguments,
 * edited as code, and (relative ones) Pin, which makes it `.move_to(…)` where it is now.
 */
function KeyArgs({ k, label }: { k: Key; label: string }) {
  const tip = `${k.why ?? ''}${k.value !== undefined ? ` — now ${fmtKey(k.value)}` : ''}. Edit its arguments here.`;
  return (
    <span className="kf-args" title={tip}>
      <Field className="mono" value={k.args} ariaLabel={`Arguments of ${keyCode(k)} for ${label}`} onChange={() => {}}
        onBlur={(v) => kfEdit((d) => setKeyArgs(d, k, v))} />
      {k.relative && (
        <button className="x-btn kf-pin" disabled={!Array.isArray(k.value)}
          title={Array.isArray(k.value) ? `Pin it where it is now: .${k.method}(…) becomes .move_to(${fmtKey(k.value)}), and it stops following what it was placed by` : 'Where it ends up is not measured yet'}
          aria-label={`Pin ${label} where it is now`} onClick={() => kfEdit((d) => fixKey(d, k))}>Pin</button>
      )}
    </span>
  );
}

function fmtKey(v: KeyValue | undefined): string {
  if (v === undefined) return '?';
  if (Array.isArray(v)) return `(${v.map((x) => Math.round(x * 100) / 100).join(', ')})`;
  return typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v;
}

const keyCode = (k: Key) => (k.method === 'Rotate' ? 'Rotate(…)' : `.${k.method}(…)`);

function MultiClipInspector({ ids }: { ids: string[] }) {
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const doc = useStore((s) => s.doc);
  const catalog = useStore((s) => s.catalog);
  const spans = ids.map((id) => lay.steps.get(id) ?? lay.anims.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const refs = ids.map((id) => findAnim(doc, id));
  const sameList = refs.every((r) => r && r.list === refs[0]?.list);
  const groups = (catalog?.animations ?? []).filter((e) => e.category === 'Composition' && !e.name.endsWith('Map')).map((e) => e.name);
  return (
    <div className="pad">
      <h3>{ids.length} clips</h3>
      {spans.length > 0 && <p className="muted small mono">{timecode(Math.min(...spans.map((s) => s.start)))} → {timecode(Math.max(...spans.map((s) => s.end)))}</p>}
      <p className="muted small">Drag them together on the timeline; Alt-drag copies them.</p>
      {sameList && (
        <section>
          <h4>Group into one animation</h4>
          <div className="chips">
            {groups.map((g) => (
              <button key={g} className="chip" title={`${g}(…) of these animations`} onClick={() => {
                let id: string | null = null;
                updateDoc((d) => void (id = groupAnims(d, ids, g)));
                if (id) selectClips([id]);
              }}>{g}</button>
            ))}
          </div>
        </section>
      )}
      <div className="row actions">
        <button onClick={() => toggleDisabled(ids)}>Toggle enabled</button>
        <button className="danger" onClick={() => deleteSelection()}>Delete</button>
        <button className="danger" title="Delete and close the gaps" onClick={() => deleteSelection(true)}>Ripple delete</button>
      </div>
    </div>
  );
}
