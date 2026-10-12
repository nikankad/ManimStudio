import { useState } from 'react';
import { api } from '../api';
import {
  addAnimation, addObject, docLayout, getState, objectClasses, deleteSelection, duplicateObject, fps, frameSnap, renameObject, sceneBase, selectClips, setState,
  timecode, toast, toggleDisabled, updateDoc, useSignature, useStore,
} from '../store';
import { addChild, findAnim, findStep, groupAnims, literal, newAnim, removeIds, reorder, setAnimDuration, setStepDuration, ungroup, type AnimRef } from '../timeline';
import { CodeArea } from './CodeArea';
import { animLabel, stepLabel } from './Timeline';
import { type Call, formatChain, parseArgs, parseChain } from '../pyparse';
import type { Anim, Args, Param, SceneDoc, SceneObject, Step } from '../types';
import { ColorField, Field, ParamField, ScrubNumber, isColorKey, quote, unquote } from './ParamField';
import { Tip, type TipContent } from './Tip';
import { versionLabel } from './Updates';
import { ActionsSection, CoupleSection, Diagnostics, GeometrySection, InstanceSection, LatexNotice, ParametersPanel, ParamSection, RelationshipSection } from './Construction';
import { EquationSection, TermsClipEditor } from './EquationEditor';
import { CONTROLLED_ARGS, isCoupled, isFollow, isRedraw, standsAlone } from '../construct';
import { coupleObjects, detachObjects, duplicateObjects, selectedObjectIds, uncoupleObjects } from '../store';
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
  }
  return (
    <aside className="panel inspector" data-tour="inspector">
      <div className="panel-title">{selection?.kind === 'clips' ? 'Effect Controls' : selection?.kind === 'object' || selection?.kind === 'objects' ? 'Properties' : 'Scene'}</div>
      <div className="scroll" tabIndex={-1}>{body ?? <SceneInfo />}</div>
    </aside>
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
      <h4>How it works</h4>
      <ul className="tips">
        <li><b>Draw</b> with the tools above the canvas (keys 1–7): points, segments, arrows, circles, rectangles, polygons. Drawing between existing points connects to them.</li>
        <li>Select objects (Shift-click for several) to <b>connect</b> them: segments, midpoints, angle marks, labels, points on graphs… They stay attached while you edit and animate.</li>
        <li><b>ƒ Graph</b> builds axes and a graph from an expression like <code>y = a*x^2 + b</code>, with parameter sliders you can animate.</li>
        <li>The <b>Constructions</b> tab holds reusable pieces: a labeled triangle, the unit circle, a number line, secant-to-tangent, and your own.</li>
        <li>Drag any manim class onto the <b>canvas</b> or straight onto a <b>timeline track</b>.</li>
        <li>The timeline is the scene’s <code>construct()</code>: each <b>self.play</b> plays its animations together (V1, V2… are its 1st, 2nd… animation), then the next statement starts. Drag clips to move them, drag their right edges to trim, and Alt-drag to duplicate.</li>
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
        <Field value={obj.name} onChange={() => undefined} onBlur={commitName} className="mono name" />
        <span className="muted">=</span>
        <Field value={obj.ctor} onChange={(v) => setObj(obj.id, (o) => void (o.ctor = v), 'ctor')} list="me-mobjects" className="mono" />
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
        <select className="field" value={obj.after ?? ''} onChange={(e) => setObj(obj.id, (o) => { if (e.target.value) o.after = e.target.value; else delete o.after; }, 'after')}>
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
        <select className="inline" value="" onChange={(e) => e.target.value && write([...(calls ?? []), { name: e.target.value, args: '' }])} disabled={!calls}>
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
  target: { title: 'Object', text: 'The object this clip animates. Pick another object’s name to animate that one instead; the timing stays the same.' },
  start: {
    title: 'Start',
    text: 'When it begins, measured by manim. A statement starts when the one before it ends, and the animations of a self.play start together (inside AnimationGroup, LaggedStart and Succession, when the group starts them). Drag the clip on the timeline to move it.',
  },
  duration: {
    title: 'Duration',
    text: 'How long the animation takes (manim’s run_time). Longer is slower: the same change is spread over more time. The self.play lasts as long as its longest animation, and everything after it moves along.',
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
      <h3 className="mono">{step.kind === 'code' ? 'Code' : step.kind === 'couple' ? 'Couple' : step.kind === 'uncouple' ? 'Uncouple' : step.kind === 'call' ? `self.${step.method}(…)` : `self.${step.kind}(…)`}</h3>
      {step.kind !== 'code' && <p className="muted small mono code-line">{label.title}</p>}
      {step.kind === 'call' && callSig?.doc && <p className="doc">{callSig.doc}</p>}
      <Diagnostics id={step.id} />
      <section className="fx-section">
        <h4>Timing</h4>
        <TimingRow id={step.id} step />
        {waitLen !== undefined && (
          <div className="fx-row"><Tip tip={CLIP_HELP.holdDuration}>Duration</Tip><ScrubNumber value={waitLen} min={1 / fps()} step={1 / fps()} precision={3} suffix="s" onChange={(v) => updateDoc((d) => setStepDuration(d, step.id, frames(v)), `${step.id}:dur`)} /></div>
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
            <select className="field mono" value={step.method} onChange={(e) => setStep(step.id, (s) => { s.method = e.target.value; s.args = {}; }, 'method')}>
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

      {(step.kind === 'add' || step.kind === 'remove') && (
        <section>
          <p className="muted small">{step.kind === 'add' ? 'Ticked objects appear on screen here, without an animation (drawn in this order, on top of what is there).' : 'Ticked objects disappear here, without an animation.'}</p>
          {objects.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={step.targets?.includes(o.name) ?? false} onChange={(e) => toggleTarget(o.name, e.target.checked)} />
              <span className="mono">{o.name}</span>
            </label>
          ))}
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

      <section><CommentField step={step} /></section>
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
        <select className="field mono" value="" onChange={(e) => e.target.value && add(e.target.value)} title="Add an animation here (it targets the selected object)">
          <option value="">+ animation…</option>
          <option value="animate">.animate</option>
          {(catalog?.animations ?? []).map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
        </select>
      </div>
      {anims.length > 1 && (
        <div className="row">
          <select className="field mono" value={groupCls} onChange={(e) => setGroupCls(e.target.value)}>
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
  const composition = !!anim.anims;
  const rt = literal(anim.args.run_time ?? (!parent ? step.args?.run_time : undefined));
  const target = sig?.target;
  const showTarget = !composition && (!target || target.kind === 'mobject' || target.kind === 'mobjects' || anim.target);
  const list = parent?.anims ?? step.anims ?? [];
  const at = list.indexOf(anim);
  const setTarget = (v: string) => setAnim(anim.id, (a) => void (a.target = v), 'target');
  return (
    <div className="pad">
      <div className="insp-head">
        <Tip tip={CLIP_HELP.cls}><Field className="mono" value={anim.cls} list="me-animations" onChange={(v) => setAnim(anim.id, (a) => void (a.cls = v), 'cls')} /></Tip>
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
          <ScrubNumber value={rt ?? (sp ? sp.end - sp.start : 1)} min={1 / fps()} step={1 / fps()} precision={3} suffix="s" onChange={(v) => updateDoc((d) => setAnimDuration(d, anim.id, frames(v)), `${anim.id}:dur`)} />
          {anim.args.run_time === undefined && <span className="muted small">{!parent && step.args?.run_time !== undefined ? 'from self.play' : 'manim’s default'}</span>}
        </div>
        <div className="fx-row"><span>In</span>
          <button className="ghost small mono" onClick={() => selectClips([parent?.id ?? step.id])} title="Select it">{parent ? parent.cls : 'self.play'}</button>
          <span className="muted small">{parent ? `#${at + 1} of ${list.length}` : `V${at + 1}`}</span>
          <button className="x-btn" disabled={at <= 0} title="Earlier" onClick={() => updateDoc((d) => reorder(d, anim.id, -1))}>↑</button>
          <button className="x-btn" disabled={at >= list.length - 1} title="Later" onClick={() => updateDoc((d) => reorder(d, anim.id, 1))}>↓</button>
        </div>
        <EnabledRow id={anim.id} disabled={anim.disabled} />
      </section>

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
