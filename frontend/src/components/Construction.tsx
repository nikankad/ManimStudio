// Inspector sections for constructions: relationships, exact geometry, parameters, actions, instances.

import { useEffect, useState } from 'react';
import { actionsFor, couplings, type Action } from '../actions';
import { api } from '../api';
import { dependentsOf, describeLink, EXPR_FIELDS, EXPR_LABELS, FOLLOW_KINDS, geoType, isFollow, linkState, literal, SOURCE_FIELDS, STANDALONE_KINDS } from '../construct';
import { countMeets } from '../intersect';
import { fmtPt, freeShape, writeShape, type Shape } from '../geometry';
import {
  addStep, animateParam, docLayout, coupleObjects, createParam, detachObjects, getState, params, recheckLatex, selectClips, selectObjects, setLink, setParamValue, setState,
  timecode, toast, uncoupleObjects, updateDoc, useStore,
} from '../store';
import { allTemplates, detachInstance, syncInstances, updateTemplateFromInstance } from '../templates';
import type { Link, Pt, SceneObject } from '../types';
import { Field, ScrubNumber } from './ParamField';

const GROUP_ORDER = ['Couple', 'Connect', 'Measure', 'Annotate', 'Terms'] as const;

/** Problems the backend found with this object or clip (missing sources, cycles, conflicts…). */
export function Diagnostics({ id }: { id: string }) {
  // Select the stored array (a fresh filtered array would re-render forever).
  const all = useStore((s) => (s.timeline ?? s.frame)?.diagnostics);
  const diags = all?.filter((d) => d.id === id) ?? [];
  if (!diags.length) return null;
  return (
    <>
      {diags.map((d, i) => (
        <div key={i} className={d.level === 'error' ? 'err-box' : d.level === 'info' ? 'muted small' : 'warn'}>
          {d.message}
          {/LaTeX isn't installed/.test(d.message) && <> <CheckLatexButton /></>}
        </div>
      ))}
    </>
  );
}

function CheckLatexButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button className="ghost small" disabled={busy} title="Look for LaTeX again after installing it (no restart needed)"
      onClick={() => { setBusy(true); void recheckLatex().finally(() => setBusy(false)); }}>
      {busy ? 'Checking…' : 'Check again'}
    </button>
  );
}

/** What works without LaTeX, how to install it, and a button to look for it again. */
export function LatexNotice() {
  const catalog = useStore((s) => s.catalog);
  if (!catalog || catalog.latex) return null;
  return (
    <div className="warn latex-notice">
      <b>LaTeX isn't installed.</b> Equations (<code>MathTex</code>, <code>Tex</code>) need it. Meanwhile, numbers (measurements, value
      labels, axis numbers) and simple labels such as <code>A</code>, <code>θ</code> or <code>x²</code> are drawn with <code>Text</code>, so
      everything else works. {catalog.latex_hint}
      <div className="row"><CheckLatexButton /></div>
    </div>
  );
}

/** Context-sensitive Connect / Measure / Annotate actions for the selection. */
export function ActionsSection({ ids, terms }: { ids: string[]; terms?: string[] }) {
  useStore((s) => s.doc);
  useStore((s) => s.frame);
  const actions = actionsFor(ids, terms);
  if (!actions.length) return null;
  return (
    <section>
      <h4>{ids.length > 1 ? 'Connect' : 'Build from this'}</h4>
      {GROUP_ORDER.map((g) => {
        const list = actions.filter((a: Action) => a.group === g);
        if (!list.length) return null;
        return (
          <div key={g} className="action-group">
            <span className="muted small">{g}</span>
            <div className="chips">{list.map((a) => <button key={a.id} className="chip" title={a.hint} onClick={a.run}>{a.label}</button>)}</div>
          </div>
        );
      })}
      {ids.length > 1 && <p className="muted small">Selection order matters for segments, circles and polygons. Shift-click on the canvas to add objects.</p>}
    </section>
  );
}

/** An editable math expression over parameters, checked by the backend. */
export function ExprField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const doc = useStore((s) => s.doc);
  const [check, setCheck] = useState<{ ok: boolean; error?: string; hint?: string; params?: string[] } | null>(null);
  const names = params(doc).map((p) => p.name);
  useEffect(() => {
    if (!value.trim() || literal(value) !== null) return setCheck(null);
    const t = setTimeout(() => api.checkValue(value, names).then(setCheck).catch(() => setCheck(null)), 250);
    return () => clearTimeout(t);
  }, [value, names.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = check && !check.ok && check.error?.startsWith('Undefined parameter') ? check.error.match(/'([^']+)'/)?.[1] : undefined;
  return (
    <div className="expr-field">
      <Field value={value} onChange={onChange} placeholder={placeholder} className={`mono ${check && !check.ok ? 'bad' : ''}`} />
      {check && !check.ok && (
        <div className="expr-err">
          {check.error}{check.hint ? ` ${check.hint}` : ''}
          {missing && <button className="ghost small" onClick={() => updateDoc((d) => void createParam(d, missing, 1, { min: -5, max: 5, step: 0.1 }))}>Create parameter {missing}</button>}
        </div>
      )}
    </div>
  );
}

function SourcePicker({ value, types, required, self, onChange }: { value: string | undefined; types: string[] | null; required: boolean; self: string; onChange: (id: string) => void }) {
  const doc = useStore((s) => s.doc);
  const options = doc.objects.filter((o) => o.id !== self && (!types || types.includes(geoType(o, doc))) && o.ctor !== 'ValueTracker');
  const missing = value && !doc.objects.some((o) => o.id === value);
  return (
    <select className={`field mono ${missing ? 'bad' : ''}`} aria-label="Source object" value={missing ? '__missing' : value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {(!required || !value) && <option value="">{required ? '— choose —' : '— none —'}</option>}
      {missing && <option value="__missing">(deleted object)</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

/** Couple / Uncouple / Forget buttons for an object's relationship. */
export function CouplingButtons({ obj }: { obj: SceneObject }) {
  const state = linkState(obj);
  if (!state) return null;
  return (
    <>
      {state === 'coupled'
        ? <button className="ghost small" title="Pause the relationship: the object stays where it is and can be edited freely. Couple again restores it." onClick={() => uncoupleObjects([obj.id])}>Uncouple</button>
        : <button className="ghost small" title="Restore the relationship: it takes over the object's place or shape again" onClick={() => coupleObjects([obj.id])}>Couple again</button>}
      <button className="ghost small" title="Remove the relationship for good: the object becomes independent where it is now" onClick={() => detachObjects([obj.id])}>Forget</button>
    </>
  );
}

const STATE_TEXT = {
  coupled: 'Coupled',
  uncoupled: 'Uncoupled',
  frozen: 'Frozen',
} as const;

/** Couple / uncouple clips that switch this object on the timeline, and buttons to add them at the playhead. */
function OverTime({ obj }: { obj: SceneObject }) {
  const steps = useStore((s) => s.doc.timeline);
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const time = useStore((s) => s.time);
  const mine = steps.filter((c) => (c.kind === 'couple' || c.kind === 'uncouple') && c.targets?.includes(obj.name));
  return (
    <div className="fx-row wide-row">
      <span>over time</span>
      <div className="chips">
        {mine.map((c) => (
          <button key={c.id} className={`chip ${c.disabled ? 'off' : ''}`} title="Select the clip" onClick={() => selectClips([c.id])}>
            {c.kind === 'couple' ? 'couple' : 'uncouple'} {timecode(lay.steps.get(c.id)?.start ?? 0)}{c.kind === 'couple' && c.duration ? ` (glide ${Math.round(c.duration * 100) / 100}s)` : ''}
          </button>
        ))}
        <button className="ghost small" title={`Add a clip that uncouples it at the playhead (${timecode(time)}): from then on it stays where it is and can be animated freely`} onClick={() => addStep('uncouple', { targets: [obj.name] })}>+ Uncouple at playhead</button>
        <button className="ghost small" title={`Add a clip that couples it again at the playhead (${timecode(time)}); give the clip a duration to glide back into place`} onClick={() => addStep('couple', { targets: [obj.name] })}>+ Couple at playhead</button>
      </div>
    </div>
  );
}

/** An object without a relationship: couple it to another existing object. */
export function CoupleSection({ obj }: { obj: SceneObject }) {
  const doc = useStore((s) => s.doc);
  useStore((s) => s.frame);
  const [to, setTo] = useState('');
  const src = doc.objects.find((o) => o.id === to);
  const options = src ? couplings(obj, [src]) : [];
  const candidates = doc.objects.filter((o) => o.id !== obj.id && o.ctor !== 'ValueTracker');
  if (obj.ctor === 'ValueTracker' || geoType(obj, doc) === 'axes' || !candidates.length) return null;
  return (
    <section className="fx-section">
      <h4>Relationship <span className="tag">independent</span></h4>
      <div className="fx-row wide-row">
        <span>couple to</span>
        <select className="field mono" aria-label="Couple to" value={src ? to : ''} onChange={(e) => setTo(e.target.value)}>
          <option value="">— choose an object —</option>
          {candidates.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      {src && (options.length
        ? <div className="chips">{options.map((a) => <button key={a.id} className="chip" title={a.hint} onClick={a.run}>{a.label}</button>)}</div>
        : <p className="muted small">No relationship from {obj.name} to {src.name}. Select more objects (shift-click) for midpoints, intersections, segments and polygons.</p>)}
    </section>
  );
}

/** The object's relationship: its state, sources, expressions and offset, editable; uncouple, couple again, forget. */
export function RelationshipSection({ obj }: { obj: SceneObject }) {
  const doc = useStore((s) => s.doc);
  const link = obj.link!;
  const l = link as Record<string, unknown>;
  const set = (fn: (l: Record<string, unknown>) => void, key: string) => setLink(obj.id, (x) => fn(x as Record<string, unknown>), `${obj.id}:link:${key}`);
  const sources = SOURCE_FIELDS[link.kind];
  const exprs = (EXPR_FIELDS[link.kind] ?? []).filter((f) => !(link.kind === 'graph' && f === 'expr') && !(link.kind === 'perpendicular' && link.mode === 'foot'));
  const infos = useStore((s) => s.frame?.objects);
  // An axes source is used as its x- or y-axis.
  const onAxes = sources.some(([f]) => geoType(doc.objects.find((o) => o.id === l[f]), doc) === 'axes');
  const users = dependentsOf(doc, [obj.id]);
  const isTermLink = (link.kind === 'attach' || link.kind === 'brace' || link.kind === 'highlight');
  const targetId = (l.to ?? l.target) as string | undefined;
  const target = doc.objects.find((o) => o.id === targetId);
  const state = linkState(obj)!;
  const owns = FOLLOW_KINDS.has(link.kind) ? 'position' : 'shape';
  return (
    <section className={`fx-section construction ${state}`}>
      <h4>Relationship <span className={`tag link-${state}`}>{STATE_TEXT[state]}</span></h4>
      <p className="muted small">{describeLink(obj, doc)}</p>
      <div className="row rel-actions"><CouplingButtons obj={obj} /></div>
      {state === 'uncoupled' && (
        <p className="muted small">
          {STANDALONE_KINDS.has(link.kind)
            ? `Paused: ${obj.name} stays where it is and is edited like any other object. Couple again and the relationship takes over its ${owns} again.`
            : `Paused: ${obj.name} keeps the ${owns} it had (built once, not updated). Couple again and it follows its sources again.`}
        </p>
      )}
      {state === 'frozen' && <p className="muted small">Frozen: built once from its sources, not updated. Couple again to keep it updated.</p>}
      <Diagnostics id={obj.id} />
      {sources.map(([f, label, types, required]) => (
        <div key={f} className="fx-row wide-row">
          <span>{label}</span>
          <SourcePicker value={l[f] as string | undefined} types={types} required={required} self={obj.id} onChange={(id) => set((x) => { if (id) x[f] = id; else delete x[f]; }, f)} />
          {Boolean(l[f]) && <button className="x-btn" title="Select it" onClick={() => selectObjects([l[f] as string])}>↗</button>}
        </div>
      ))}
      {link.kind === 'polygon' && (
        <div className="chips">{link.points.map((p, i) => <button key={i} className="chip" onClick={() => selectObjects([p])}>{doc.objects.find((o) => o.id === p)?.name ?? '(deleted)'}</button>)}</div>
      )}
      {isTermLink && target?.eq?.parts?.length ? (
        <div className="fx-row wide-row">
          <span>terms</span>
          <div className="chips">
            {target.eq.parts.map((p) => {
              const on = ((l.parts as string[] | undefined) ?? []).includes(p.id);
              return <button key={p.id} className={`chip mono ${on ? 'on' : ''}`} onClick={() => set((x) => {
                const cur = (x.parts as string[] | undefined) ?? [];
                const next = on ? cur.filter((y) => y !== p.id) : [...cur, p.id];
                if (next.length) x.parts = next;
                else delete x.parts;
              }, 'parts')}>{p.tex}</button>;
            })}
          </div>
        </div>
      ) : null}
      {link.kind === 'measure' && (
        <div className="fx-row">
          <span>shows</span>
          <select className="field" aria-label="Shows" value={link.what} onChange={(e) => set((x) => void (x.what = e.target.value), 'what')}>
            {['length', 'angle', 'slope', 'integral', 'value'].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
      )}
      {link.kind === 'measure' && <p className="muted small">{link.what === 'integral' ? 'Numerical approximation (trapezoid rule) computed in the scene.' : link.what === 'value' ? 'Computed from parameters.' : 'Computed by manim from the source.'}</p>}
      {(link.kind === 'area' || link.kind === 'riemann') && <p className="muted small">Visual shading only — no value is computed. Use “Show integral” for a number.</p>}
      {link.kind === 'segment' && (
        <div className="seg">
          {(['center', 'boundary'] as const).map((m) => <button key={m} className={(link.mode ?? 'center') === m ? 'on' : ''} onClick={() => set((x) => void (x.mode = m), 'mode')}>{m === 'center' ? 'center to center' : 'boundary to boundary'}</button>)}
        </div>
      )}
      {link.kind === 'circle2' && (
        <div className="seg">
          {(['center', 'diameter'] as const).map((m) => <button key={m} className={(link.mode ?? 'center') === m ? 'on' : ''} onClick={() => set((x) => void (x.mode = m), 'mode')}>{m === 'center' ? 'center + point' : 'diameter'}</button>)}
        </div>
      )}
      {onAxes && (
        <div className="seg">
          {(['x', 'y'] as const).map((a) => <button key={a} className={(l.axis ?? 'x') === a ? 'on' : ''} onClick={() => set((x) => { if (a === 'y') x.axis = 'y'; else delete x.axis; }, 'axis')}>{a}-axis</button>)}
        </div>
      )}
      {link.kind === 'intersection' && (() => {
        const now = infos ? countMeets(doc, infos, link.a, link.b, link.axis) : 0;
        const which = link.which ?? 0;
        return (
          <>
            <div className="fx-row wide-row">
              <span>which</span>
              <div className="chips">
                {Array.from({ length: Math.max(now, which + 1) }, (_, i) => (
                  <button key={i} className={`chip ${which === i ? 'on' : ''}`} title={i < now ? undefined : 'They don’t meet this many times right now'} onClick={() => set((x) => { if (i) x.which = i; else delete x.which; }, 'which')}>{i + 1}{i < now ? '' : ' ?'}</button>
                ))}
              </div>
            </div>
            <p className="muted small">
              {now === 0 ? 'They don’t meet right now: the point stays where it was until they do. ' : `They meet ${now === 1 ? 'once' : `${now} times`} right now. `}
              Lines count as extended both ways. Order: along a line from its start, left then right for two circles, by x on a graph.
            </p>
          </>
        );
      })()}
      {link.kind === 'perpendicular' && (
        <div className="seg">
          {(['line', 'foot'] as const).map((m) => <button key={m} className={(link.mode ?? 'line') === m ? 'on' : ''} onClick={() => set((x) => { if (m === 'foot') x.mode = 'foot'; else delete x.mode; }, 'mode')}>{m === 'line' ? 'line through the point' : 'from the point to the line'}</button>)}
        </div>
      )}
      {link.kind === 'riemann' && (
        <div className="fx-row">
          <span>sample</span>
          <select className="field" aria-label="Sample" value={link.sample ?? 'left'} onChange={(e) => set((x) => void (x.sample = e.target.value), 'sample')}>
            {['left', 'right', 'center'].map((w) => <option key={w}>{w}</option>)}
          </select>
        </div>
      )}
      {link.kind === 'angle' && (
        <label className="check"><input type="checkbox" checked={!!link.other} onChange={(e) => set((x) => void (x.other = e.target.checked), 'other')} /> other angle</label>
      )}
      {(link.kind === 'brace') && (
        <div className="fx-row"><span>direction</span>
          <select className="field mono" aria-label="Direction" value={link.direction ?? 'DOWN'} onChange={(e) => set((x) => void (x.direction = e.target.value), 'dir')}>
            {['DOWN', 'UP', 'LEFT', 'RIGHT'].map((d) => <option key={d}>{d}</option>)}
          </select>
        </div>
      )}
      {link.kind === 'highlight' && (
        <div className="seg">
          {(['box', 'background', 'underline'] as const).map((m) => <button key={m} className={(link.style ?? 'box') === m ? 'on' : ''} onClick={() => set((x) => void (x.style = m), 'style')}>{m}</button>)}
        </div>
      )}
      {exprs.map((f) => (
        <div key={f} className="fx-row wide-row">
          <span>{EXPR_LABELS[f] ?? f}</span>
          <ExprField value={String(l[f] ?? '')} placeholder={f === 'radius' ? 'auto' : link.kind === 'parallel' && f === 'length' ? 'same as the line' : link.kind === 'perpendicular' && f === 'length' ? '4' : ''} onChange={(v) => set((x) => { if (v.trim()) x[f] = v; else delete x[f]; }, f)} />
        </div>
      ))}
      {link.kind === 'graph' && <GraphFields obj={obj} link={link} />}
      {(link.kind === 'attach' || link.kind === 'measure') && (
        <div className="fx-row">
          <span>offset</span>
          <ScrubNumber value={link.offset?.[0] ?? 0} step={0.02} onChange={(v) => set((x) => void (x.offset = [v, (link.offset ?? [0, 0])[1]]), 'ox')} />
          <ScrubNumber value={link.offset?.[1] ?? 0} step={0.02} onChange={(v) => set((x) => void (x.offset = [(link.offset ?? [0, 0])[0], v]), 'oy')} />
        </div>
      )}
      {state !== 'frozen' && <OverTime obj={obj} />}
      {users.length > 0 && <p className="muted small">Used by {users.map((u) => u.name).join(', ')}.</p>}
      {state === 'coupled' && <p className="muted small">{isFollow(obj) ? 'Animations can change its color, opacity, scale and rotation; movement comes from the relationship (uncouple it over time to move it yourself).' : 'Animations can change its color and opacity, and Create/FadeIn it; its shape comes from the relationship.'}</p>}
    </section>
  );
}

/** Expression, domain and discontinuities of a graph built from an expression. */
function GraphFields({ obj, link }: { obj: SceneObject; link: Extract<Link, { kind: 'graph' }> }) {
  const doc = useStore((s) => s.doc);
  const values = useStore((s) => s.frame?.values) ?? {};
  const [analysis, setAnalysis] = useState<Awaited<ReturnType<typeof api.analyzeFunction>> | null>(null);
  const axes = useStore((s) => s.frame?.objects.find((o) => o.id === link.axes)?.axes);
  const domain: [number, number] = [link.x_min ?? axes?.x_range[0] ?? -5, link.x_max ?? axes?.x_range[1] ?? 5];
  const set = (fn: (l: Extract<Link, { kind: 'graph' }>) => void, key: string) => setLink(obj.id, (x) => fn(x as Extract<Link, { kind: 'graph' }>), `${obj.id}:graph:${key}`);
  const known = Object.fromEntries(params(doc).map((p) => [p.name, values[p.name] ?? literal(p.args['*']) ?? 1]));
  useEffect(() => {
    const t = setTimeout(() => api.analyzeFunction(link.expr, known, domain, axes?.y_range).then(setAnalysis).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [link.expr, domain[0], domain[1], JSON.stringify(known)]); // eslint-disable-line react-hooks/exhaustive-deps
  const disc = link.discontinuities ?? [];
  return (
    <>
      <div className="fx-row wide-row"><span>y =</span><Field className={`mono ${analysis && !analysis.ok ? 'bad' : ''}`} value={link.expr} onChange={(v) => set((x) => void (x.expr = v), 'expr')} /></div>
      {analysis && !analysis.ok && <div className="expr-err">{analysis.error} {analysis.hint}</div>}
      {analysis?.undefined.map((p) => (
        <button key={p} className="ghost small" onClick={() => updateDoc((d) => void createParam(d, p, 1, { min: -5, max: 5, step: 0.1 }))}>Create parameter {p}</button>
      ))}
      <div className="fx-row"><span>domain</span>
        <ScrubNumber value={domain[0]} step={0.05} onChange={(v) => set((x) => void (x.x_min = v), 'xmin')} />
        <ScrubNumber value={domain[1]} step={0.05} onChange={(v) => set((x) => void (x.x_max = v), 'xmax')} />
      </div>
      <div className="fx-row wide-row"><span>breaks at</span>
        <div className="chips">
          {disc.map((d, i) => (
            <span key={i} className="chip value-chip mono">{d}<button className="x-btn" title="Remove" aria-label="Remove" onClick={() => set((x) => void (x.discontinuities = disc.filter((_, k) => k !== i)), 'disc')}>×</button></span>
          ))}
          {analysis?.ok && analysis.discontinuities.join() !== disc.join() && (
            <button className="ghost small" title="Use the jumps found by sampling the function" onClick={() => set((x) => {
              x.discontinuities = analysis.discontinuities;
              x.gap = analysis.gap ?? undefined;
            }, 'disc')}>{analysis.discontinuities.length ? `Use detected (${analysis.discontinuities.map((v) => Math.round(v * 1000) / 1000).join(', ')})` : 'None detected'}</button>
          )}
        </div>
      </div>
      {disc.length > 0 && <div className="fx-row"><span>gap</span><ScrubNumber value={link.gap ?? 0.01} min={0.0001} step={0.005} precision={4} onChange={(v) => set((x) => void (x.gap = v), 'gap')} /></div>}
      {analysis?.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
    </>
  );
}

/** Exact numeric entry for free shapes (endpoints, center, radius, size, vertices). */
export function GeometrySection({ obj }: { obj: SceneObject }) {
  const shape = freeShape(obj);
  if (!shape || shape.kind === 'point') return null;
  const write = (s: Shape, key: string) => updateDoc((d) => writeShape(d.objects.find((o) => o.id === obj.id)!, s), `${obj.id}:geo:${key}`);
  const pt = (label: string, p: Pt, set: (p: Pt) => void, key: string) => (
    <div key={key} className="fx-row"><span>{label}</span>
      <ScrubNumber value={p[0]} step={0.02} precision={3} onChange={(v) => set([v, p[1]])} />
      <ScrubNumber value={p[1]} step={0.02} precision={3} onChange={(v) => set([p[0], v])} />
    </div>
  );
  return (
    <section className="fx-section">
      <h4>Geometry</h4>
      {shape.kind === 'line' && (
        <>
          {pt('Start', shape.start, (p) => write({ ...shape, start: p }, 'start'), 'start')}
          {pt('End', shape.end, (p) => write({ ...shape, end: p }, 'end'), 'end')}
          <div className="fx-row"><span>Length</span><ScrubNumber value={Math.hypot(shape.end[0] - shape.start[0], shape.end[1] - shape.start[1])} min={0.001} step={0.02} precision={3} onChange={(len) => {
            const d = [shape.end[0] - shape.start[0], shape.end[1] - shape.start[1]];
            const k = len / (Math.hypot(d[0], d[1]) || 1);
            write({ ...shape, end: [shape.start[0] + d[0] * k, shape.start[1] + d[1] * k] }, 'len');
          }} /></div>
        </>
      )}
      {shape.kind === 'circle' && (
        <>
          {pt('Center', shape.center, (p) => write({ ...shape, center: p }, 'center'), 'center')}
          <div className="fx-row"><span>Radius</span><ScrubNumber value={shape.r} min={0.01} step={0.02} precision={3} onChange={(r) => write({ ...shape, r }, 'r')} /></div>
        </>
      )}
      {shape.kind === 'rect' && (
        <>
          {pt('Center', shape.center, (p) => write({ ...shape, center: p }, 'center'), 'center')}
          <div className="fx-row"><span>{shape.square ? 'Side' : 'Size'}</span>
            <ScrubNumber value={shape.w} min={0.01} step={0.02} precision={3} onChange={(w) => write({ ...shape, w, h: shape.square ? w : shape.h }, 'w')} />
            {!shape.square && <ScrubNumber value={shape.h} min={0.01} step={0.02} precision={3} onChange={(h) => write({ ...shape, h }, 'h')} />}
          </div>
        </>
      )}
      {shape.kind === 'polygon' && (
        <>
          {shape.vertices.map((v, i) => pt(`Vertex ${i + 1}`, v, (p) => write({ ...shape, vertices: shape.vertices.map((x, k) => (k === i ? p : x)) }, `v${i}`), `v${i}`))}
          <div className="row">
            <button className="ghost small" onClick={() => {
              const a = shape.vertices[shape.vertices.length - 1], b = shape.vertices[0];
              write({ ...shape, vertices: [...shape.vertices, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]] }, 'add');
            }}>+ vertex</button>
            <button className="ghost small" disabled={shape.vertices.length <= 3} onClick={() => write({ ...shape, vertices: shape.vertices.slice(0, -1) }, 'rm')}>− vertex</button>
          </div>
        </>
      )}
      <p className="muted small">Drag the round handles on the canvas, or type exact values here. Python: <code>{shape.kind === 'line' ? `start=${fmtPt(shape.start)}` : shape.kind === 'polygon' ? 'Polygon(*vertices)' : shape.kind === 'circle' ? `radius=${Math.round(shape.r * 1000) / 1000}` : 'width/height'}</code></p>
    </section>
  );
}

/** A ValueTracker used as a named parameter: slider, bounds, animate. */
export function ParamSection({ obj }: { obj: SceneObject }) {
  const doc = useStore((s) => s.doc);
  const live = useStore((s) => s.frame?.values?.[obj.name]);
  const meta = obj.param ?? { min: -5, max: 5, step: 0.1 };
  const value = literal(obj.args['*']);
  const [to, setTo] = useState(String(meta.max));
  const [dur, setDur] = useState('1');
  const users = dependentsOf(doc, [obj.id]);
  const setMeta = (patch: Partial<typeof meta>) => updateDoc((d) => {
    const o = d.objects.find((x) => x.id === obj.id)!;
    o.param = { ...meta, ...patch };
  }, `${obj.id}:meta`);
  return (
    <section className="fx-section">
      <h4>Parameter</h4>
      {value === null ? (
        <p className="muted small">The starting value is a Python expression ({obj.args['*']}); edit it below.</p>
      ) : (
        <ParamSlider name={obj.name} value={value} meta={meta} />
      )}
      {live !== undefined && <p className="muted small">At the playhead: {Math.round(live * 1000) / 1000}</p>}
      <div className="fx-row"><span>Bounds</span>
        <ScrubNumber value={meta.min} step={0.1} onChange={(v) => setMeta({ min: v })} />
        <ScrubNumber value={meta.max} step={0.1} onChange={(v) => setMeta({ max: v })} />
      </div>
      <div className="fx-row"><span>Step</span><ScrubNumber value={meta.step} min={0.0001} step={0.01} precision={4} onChange={(v) => setMeta({ step: v })} /></div>
      <div className="row">
        <span className="muted small">Animate to</span>
        <input className="field num narrow" value={to} onChange={(e) => setTo(e.target.value)} />
        <span className="muted small">over</span>
        <input className="field num narrow" value={dur} onChange={(e) => setDur(e.target.value)} />
        <span className="muted small">s</span>
        <button className="ghost small" onClick={() => {
          const v = Number(to), d = Number(dur);
          if (Number.isNaN(v) || !(d > 0)) return toast('Enter a number and a duration');
          animateParam(obj.name, v, d);
        }}>Add at playhead</button>
      </div>
      {users.length > 0 ? <p className="muted small">Used by {users.map((u) => u.name).join(', ')}.</p> : <p className="muted small">Not used yet. Use its name in expressions, e.g. <code>{obj.name}*x^2</code>.</p>}
    </section>
  );
}

export function ParamSlider({ name, value, meta }: { name: string; value: number; meta: { min: number; max: number; step: number } }) {
  return (
    <div className="param-slider">
      <span className="mono">{name}</span>
      <input type="range" className="slider" min={Math.min(meta.min, value)} max={Math.max(meta.max, value)} step={meta.step} value={value} onChange={(e) => setParamValue(name, Number(e.target.value))} />
      <ScrubNumber value={value} step={meta.step} precision={4} onChange={(v) => setParamValue(name, v)} />
    </div>
  );
}

/** Every parameter of the scene, as sliders (shared by graphs and labels). */
export function ParametersPanel() {
  const doc = useStore((s) => s.doc);
  const list = params(doc);
  return (
    <section>
      <h4>Parameters <span className="spacer" /><button className="ghost small" onClick={() => {
        let name = '';
        updateDoc((d) => void (name = createParam(d, 'a', 1, { min: -5, max: 5, step: 0.1 })));
        const o = getState().doc.objects.find((x) => x.name === name);
        if (o) selectObjects([o.id]);
      }}>+ parameter</button></h4>
      {list.length === 0 && <p className="muted small">Parameters are ValueTrackers you can share between graphs, points and labels, and animate on the timeline.</p>}
      {list.map((p) => {
        const v = literal(p.args['*']);
        return v === null ? (
          <div key={p.id} className="row"><button className="ghost small mono" onClick={() => selectObjects([p.id])}>{p.name}</button><span className="muted small">= {p.args['*']}</span></div>
        ) : (
          <div key={p.id} className="row param-row">
            <button className="x-btn" title="Select" onClick={() => selectObjects([p.id])}>↗</button>
            <ParamSlider name={p.name} value={v} meta={p.param ?? { min: Math.min(-5, v), max: Math.max(5, v), step: 0.1 }} />
          </div>
        );
      })}
      <button className="ghost small" onClick={() => setState({ panel: 'graph', panelData: null })}>ƒ Graph a function…</button>
    </section>
  );
}

/** Membership of an inserted construction. */
export function InstanceSection({ obj }: { obj: SceneObject }) {
  const inst = obj.instance!;
  const tpl = allTemplates().find((t) => t.id === inst.template);
  const inProject = (getState().doc.constructions ?? []).some((t) => t.id === inst.template);
  return (
    <section className="fx-section">
      <h4>Construction instance</h4>
      <p className="muted small">
        Part of <b>{tpl?.name ?? 'a construction'}</b>, {inst.linked ? 'linked to its template: "Update instances" regenerates it (only its inputs are kept).' : 'an independent copy.'}
      </p>
      <div className="row">
        <button className="ghost small" onClick={() => selectObjects(getState().doc.objects.filter((o) => o.instance?.instance === inst.instance).map((o) => o.id))}>Select all parts</button>
        {inst.linked && <button className="ghost small" onClick={() => syncInstances(inst.template)}>Update instances</button>}
        {inst.linked && inProject && <button className="ghost small" title="Save this instance's structure as the template, then update the others" onClick={() => updateTemplateFromInstance(inst.instance)}>Push to template</button>}
        <button className="ghost small" onClick={() => detachInstance(inst.instance)}>{inst.linked ? 'Unlink' : 'Forget'}</button>
      </div>
    </section>
  );
}
