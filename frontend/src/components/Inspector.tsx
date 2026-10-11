import { useState } from 'react';
import { api } from '../api';
import {
  addAnimation, addObject, clipDuration, getState, objectClasses, deleteSelection, duplicateObject, fps, frameSnap, renameObject, setState, timecode, toast, updateDoc,
  useSignature, useStore,
} from '../store';
import { type Call, formatChain, parseArgs, parseChain } from '../pyparse';
import type { Args, Clip, Param, SceneDoc, SceneObject } from '../types';
import { ColorField, Field, ParamField, ScrubNumber, isColorKey, quote, unquote } from './ParamField';

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
  } else if (selection?.kind === 'clips') {
    const clips = doc.clips.filter((c) => selection.ids.includes(c.id));
    if (clips.length === 1) body = <ClipInspector key={clips[0].id} clip={clips[0]} />;
    else if (clips.length > 1) body = <MultiClipInspector clips={clips} />;
  }
  return (
    <aside className="panel inspector">
      <div className="panel-title">{selection?.kind === 'clips' ? 'Effect Controls' : selection?.kind === 'object' ? 'Properties' : 'Scene'}</div>
      <div className="scroll">{body ?? <SceneInfo />}</div>
    </aside>
  );
}

function SceneInfo() {
  const catalog = useStore((s) => s.catalog);
  const doc = useStore((s) => s.doc);
  return (
    <div className="pad">
      <p className="muted">
        <b>{doc.scene.name}</b>({doc.scene.base}) · {doc.config.pixel_width}×{doc.config.pixel_height} @ {doc.config.frame_rate}fps
      </p>
      <button onClick={() => setState({ panel: 'settings' })}>Scene settings…</button>
      <h4>How it works</h4>
      <ul className="tips">
        <li>Drag any manim class onto the <b>canvas</b> or straight onto a <b>timeline track</b>.</li>
        <li>Clips can sit anywhere on any track and overlap. Drag to move them, drag their edges to trim, and Alt-drag to duplicate.</li>
        <li>On the canvas, drag an object to move it. Corner handles scale it, edge handles stretch it, and the top knob rotates it. With <b>Record</b> on, each of these becomes an animation clip at the playhead.</li>
        <li>Every field takes Python, like <code>BLUE</code>, <code>UP * 2</code> or <code>lambda x: x**2</code>.</li>
        <li><b>Code</b> clips run any manim code, such as updaters or ValueTrackers.</li>
      </ul>
      <h4>Keys</h4>
      <ul className="tips keys">
        <li><kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> frame · <kbd>↑</kbd><kbd>↓</kbd> edit points</li>
        <li><kbd>M</kbd> marker · <kbd>S</kbd> snap · <kbd>=</kbd>/<kbd>-</kbd> zoom · <kbd>\</kbd> fit</li>
        <li><kbd>Del</kbd> delete · <kbd>⇧Del</kbd> ripple delete · <kbd>⌘C</kbd>/<kbd>⌘V</kbd> clips</li>
      </ul>
      {catalog && !catalog.latex && (
        <div className="warn">LaTeX was not found, so <code>MathTex</code> and <code>Tex</code> won't render. Install TeX Live, MacTeX or MiKTeX. <code>Text</code> works without it.</div>
      )}
      {catalog && <p className="muted small">manim {catalog.manim_version}</p>}
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
  const content = TEXT_CTORS.has(obj.ctor) ? unquote(obj.args['*'] ?? '') : null;
  const isVector = sig?.vector ?? true;
  const paramNames = new Set(sig?.params.map((p) => p.name) ?? []);
  const styleKeys = STYLE_KEYS.filter((k) => paramNames.has(k) || obj.args[k] !== undefined);

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
      {sig?.unknown && <p className="warn small">Unknown constructor. It will still be passed to Python as written.</p>}

      {(content !== null || (TEXT_CTORS.has(obj.ctor) && !obj.args['*'])) && (
        <section>
          <h4>{obj.ctor === 'Text' || obj.ctor === 'MarkupText' || obj.ctor === 'Paragraph' ? 'Text' : 'LaTeX'}</h4>
          <Field multiline className="mono content" value={content ?? ''} onChange={(v) => setObj(obj.id, (o) => void (o.args['*'] = quote(v)), 'content')} />
        </section>
      )}

      <section className="fx-section">
        <h4>Transform {obj.pos && <button className="ghost small" title="Let manim position it" onClick={() => setObj(obj.id, (o) => void (o.pos = null), 'pos')}>auto position</button>}</h4>
        <div className="fx-row"><span>Position</span><ScrubNumber value={obj.pos?.[0] ?? center?.[0] ?? null} onChange={(v) => setPos(0, v)} step={0.02} /><ScrubNumber value={obj.pos?.[1] ?? center?.[1] ?? null} onChange={(v) => setPos(1, v)} step={0.02} /></div>
        <div className="fx-row"><span>Scale</span><ScrubNumber value={obj.scale ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.scale = v), 'scale')} /></div>
        <div className="fx-row"><span>Stretch</span>
          <ScrubNumber value={obj.stretch?.[0] ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.stretch = [v, o.stretch?.[1] ?? 1]), 'sx')} />
          <ScrubNumber value={obj.stretch?.[1] ?? 1} min={0.01} step={0.01} precision={3} onChange={(v) => setObj(obj.id, (o) => void (o.stretch = [o.stretch?.[0] ?? 1, v]), 'sy')} />
        </div>
        <div className="fx-row"><span>Rotation</span><ScrubNumber value={obj.rotation ?? 0} step={0.5} precision={1} suffix="°" onChange={(v) => setObj(obj.id, (o) => void (o.rotation = v), 'rot')} /></div>
      </section>

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

      <ArgsEditor params={(sig?.params ?? []).filter((p) => !styleKeys.includes(p.name))} args={Object.fromEntries(Object.entries(obj.args).filter(([k]) => !styleKeys.includes(k)))} hideStar={content !== null} onChange={(k, v) => setObj(obj.id, (o) => setArg(o.args, k, v), 'arg:' + k)} />

      <ChainEditor title="Method chain" cls={chainCls} chain={obj.chain} placeholder=".set_fill(BLUE, opacity=0.5)" onChange={(v) => setObj(obj.id, (o) => void (o.chain = v), 'chain')} />

      {(chainSig?.factories?.length ?? 0) > 0 && (
        <section>
          <h4>Create from {obj.name}</h4>
          <div className="chips">
            {chainSig!.factories!.map((f) => <button key={f} className="chip" title={`New object = ${obj.name}.${f}(…)`} onClick={() => void createFrom(obj.name, chainCls, f)}>{f}</button>)}
          </div>
        </section>
      )}

      <section>
        <h4>Animate at playhead</h4>
        <div className="chips">
          {QUICK_ANIMS.map((a) => <button key={a} className="chip" onClick={() => addAnimation(a, obj.name)}>{a}</button>)}
          <button className="chip" onClick={() => addAnimation('animate', obj.name)}>.animate</button>
        </div>
      </section>

      <div className="row actions">
        <button onClick={() => duplicateObject(obj.id)}>Duplicate</button>
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
function ChainEditor({ chain, cls, onChange, title, placeholder }: { chain: string; cls: string; onChange: (v: string) => void; title: string; placeholder: string }) {
  const sig = useSignature(cls);
  const common = useStore((s) => s.catalog?.methods ?? []);
  const [raw, setRaw] = useState(false);
  const calls = parseChain(chain);
  const methods = sig?.methods ?? common;
  const top = methods.filter((m) => common.includes(m));
  const rest = methods.filter((m) => !common.includes(m));
  const write = (next: Call[]) => onChange(formatChain(next));
  return (
    <section>
      <h4>
        {title}{' '}
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

function setClip(id: string, fn: (c: Clip) => void, key: string) {
  updateDoc((d) => {
    const c = d.clips.find((x) => x.id === id);
    if (c) fn(c);
  }, `${id}:${key}`);
}

function ClipInspector({ clip }: { clip: Clip }) {
  const objects = useStore((s) => s.doc.objects);
  const tracks = useStore((s) => s.doc.tracks);
  const timeline = useStore((s) => s.timeline);
  const sig = useSignature(clip.kind === 'anim' && clip.cls !== 'animate' ? clip.cls ?? '' : '');
  const dur = clipDuration(clip, timeline);
  const targetCls = useChainClass(clip.target);
  const timed = clip.kind === 'anim' || clip.kind === 'hold';
  const frames = (v: number) => Math.round(v * fps()) / fps();
  return (
    <div className="pad">
      {clip.kind === 'anim' && (
        <div className="insp-head">
          <Field className="mono" value={clip.cls ?? ''} list="me-animations" onChange={(v) => setClip(clip.id, (c) => void (c.cls = v), 'cls')} />
          <span className="muted">(</span>
          <Field className="mono" value={clip.target ?? ''} list="me-targets" onChange={(v) => setClip(clip.id, (c) => void (c.target = v), 'target')} />
          <span className="muted">)</span>
        </div>
      )}
      {clip.kind !== 'anim' && <h3>{clip.kind === 'code' ? 'Code clip' : clip.kind === 'hold' ? 'Hold' : `self.${clip.kind}(…)`}</h3>}
      {sig?.doc && <p className="doc">{sig.doc}</p>}

      <section className="fx-section">
        <h4>Timing</h4>
        <div className="fx-row"><span>Start</span><ScrubNumber value={clip.start} min={0} step={1 / fps()} precision={3} suffix="s" onChange={(v) => setClip(clip.id, (c) => void (c.start = frames(v)), 'start')} /><span className="muted small mono">{timecode(clip.start)}</span></div>
        {timed && <div className="fx-row"><span>Duration</span><ScrubNumber value={clip.duration} min={1 / fps()} step={1 / fps()} precision={3} suffix="s" onChange={(v) => setClip(clip.id, (c) => void (c.duration = frames(v)), 'dur')} /><span className="muted small mono">→ {timecode(clip.start + clip.duration)}</span></div>}
        {clip.kind === 'code' && <div className="fx-row"><span>Measured</span><span className="mono">{dur.toFixed(2)}s</span></div>}
        <div className="fx-row">
          <span>Track</span>
          <select className="field" value={clip.track} onChange={(e) => setClip(clip.id, (c) => void (c.track = e.target.value), 'track')}>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <label className="check"><input type="checkbox" checked={!clip.disabled} onChange={(e) => setClip(clip.id, (c) => void (c.disabled = !e.target.checked), 'dis')} /> enabled</label>
      </section>

      {clip.kind === 'anim' && clip.cls === 'animate' && (
        <>
          <ChainEditor title="Methods to animate" cls={targetCls} chain={clip.chain ?? ''} placeholder=".shift(RIGHT * 2).rotate(PI / 2)" onChange={(v) => setClip(clip.id, (c) => void (c.chain = v), 'chain')} />
          <ArgsEditor title="Animation" params={[{ name: 'rate_func', label: 'rate_func', kind: 'rate_func', default: 'smooth', required: false, annotation: '', from: '' }]} args={clip.args ?? {}} onChange={(k, v) => setClip(clip.id, (c) => setArg((c.args ??= {}), k, v), 'arg:' + k)} />
        </>
      )}
      {clip.kind === 'anim' && clip.cls !== 'animate' && (
        <ArgsEditor params={(sig?.params ?? []).filter((p) => p.name !== 'run_time')} args={clip.args ?? {}} onChange={(k, v) => setClip(clip.id, (c) => setArg((c.args ??= {}), k, v), 'arg:' + k)} />
      )}

      {clip.kind === 'code' && (
        <section>
          <label className="param"><span className="pname">label</span><Field value={clip.label ?? ''} placeholder="Code" onChange={(v) => setClip(clip.id, (c) => void (c.label = v), 'label')} /></label>
          <p className="muted small">Runs inside <code>construct(self)</code> at this time. Every object variable is in scope, and <code>self.play</code> calls here take their own time.</p>
          <Field multiline className="mono code-input" value={clip.code ?? ''} onChange={(v) => setClip(clip.id, (c) => void (c.code = v), 'code')} />
        </section>
      )}

      {(clip.kind === 'add' || clip.kind === 'remove') && (
        <section>
          {objects.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={clip.targets?.includes(o.name) ?? false} onChange={(e) => setClip(clip.id, (c) => {
                const t = c.targets ?? [];
                c.targets = e.target.checked ? [...t, o.name] : t.filter((x) => x !== o.name);
              }, 'targets')} />
              <span className="mono">{o.name}</span>
            </label>
          ))}
        </section>
      )}

      <div className="row actions">
        <button onClick={() => setState({ time: frameSnap(clip.start + dur), showVideo: false })}>Go to end</button>
        <button className="danger" onClick={() => deleteSelection()}>Delete clip</button>
      </div>
    </div>
  );
}

function MultiClipInspector({ clips }: { clips: Clip[] }) {
  const t0 = Math.min(...clips.map((c) => c.start));
  return (
    <div className="pad">
      <h3>{clips.length} clips</h3>
      <p className="muted small mono">{timecode(t0)} → {timecode(Math.max(...clips.map((c) => c.start + c.duration)))}</p>
      <section className="fx-section">
        <div className="fx-row"><span>Shift all</span>
          <ScrubNumber value={t0} min={0} step={1 / fps()} precision={3} suffix="s" onChange={(v) => updateDoc((d) => {
            const ids = new Set(clips.map((c) => c.id));
            for (const c of d.clips) if (ids.has(c.id)) c.start = Math.max(0, Math.round((c.start + v - t0) * fps()) / fps());
          }, 'multi-shift')} />
        </div>
      </section>
      <div className="row actions">
        <button onClick={() => updateDoc((d) => d.clips.filter((c) => clips.some((k) => k.id === c.id)).forEach((c) => (c.disabled = !c.disabled)))}>Toggle enabled</button>
        <button className="danger" onClick={() => deleteSelection()}>Delete</button>
      </div>
    </div>
  );
}
