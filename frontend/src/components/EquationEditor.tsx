// Equations: structured input (MathLive, loaded on demand), LaTeX access, terms, and term correspondences.

import { useEffect, useRef, useState } from 'react';
import { colorTerms } from '../actions';
import { api, type EquationCheck } from '../api';
import { autoPairs, joinTerms, mergeTerms, normalizeLatex, splitTerms, termLabel } from '../equation';
import { geoType } from '../construct';
import { getState, setState, updateDoc, useStore } from '../store';
import type { Anim, EqPart, SceneObject } from '../types';
import { ColorField, Field, quote, unquote } from './ParamField';

type MathfieldLike = HTMLElement & { value: string; getValue(format: string): string; mathVirtualKeyboardPolicy: string };

let mathlive: Promise<typeof import('mathlive')> | null = null;
/** Load MathLive and its fonts once, bundled with the app (no CDN, works offline in the desktop window). */
function loadMathLive() {
  mathlive ??= Promise.all([import('mathlive'), import('mathlive/fonts.css')]).then(([ml]) => {
    ml.MathfieldElement.fontsDirectory = null; // fonts come from the bundled fonts.css
    ml.MathfieldElement.soundsDirectory = null;
    return ml;
  });
  return mathlive;
}

/** MathLive math field; emits LaTeX that real LaTeX (MathTex) accepts. Falls back to plain LaTeX if it can't load. */
export function MathField({ value, onChange }: { value: string; onChange: (latex: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const mf = useRef<MathfieldLike | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const [state, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    let alive = true;
    loadMathLive().then((ml) => {
      if (!alive || !host.current) return;
      const el = new ml.MathfieldElement() as unknown as MathfieldLike;
      el.mathVirtualKeyboardPolicy = 'manual';
      el.value = value;
      el.addEventListener('input', () => cb.current(normalizeLatex(el.getValue('latex-expanded'))));
      host.current.appendChild(el);
      mf.current = el;
      setLoad('ready');
    }).catch(() => alive && setLoad('failed'));
    return () => {
      alive = false;
      mf.current?.remove();
      mf.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = mf.current;
    if (el && document.activeElement !== el && normalizeLatex(el.getValue('latex-expanded')) !== value) el.value = value;
  }, [value]);
  return (
    <div className="mathfield-host" ref={host}>
      {state === 'loading' && <span className="muted small">Loading math input…</span>}
      {state === 'failed' && <span className="muted small">Math input unavailable here; edit the LaTeX below.</span>}
    </div>
  );
}

const setEq = (id: string, fn: (o: SceneObject) => void, key: string) => updateDoc((d) => {
  const o = d.objects.find((x) => x.id === id);
  if (o) fn(o);
}, `${id}:eq:${key}`);

/** Write the terms back, keeping args["*"] in sync so the raw Python stays readable. */
function writeParts(o: SceneObject, parts: EqPart[]) {
  o.eq = { parts };
  o.args['*'] = quote(joinTerms(parts));
}

/** Equation editor for MathTex / Tex: math input, LaTeX, terms, color and annotation of selected terms, manim check. */
export function EquationSection({ obj }: { obj: SceneObject }) {
  const selection = useStore((s) => s.selection);
  const parts = obj.eq?.parts ?? [];
  const split = parts.length > 0;
  const latex = split ? joinTerms(parts) : unquote(obj.args['*'] ?? '') ?? '';
  const editableLatex = split || unquote(obj.args['*'] ?? '') !== null || !obj.args['*'];
  const terms = selection?.kind === 'object' && selection.id === obj.id ? selection.terms ?? [] : [];
  const [check, setCheck] = useState<EquationCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const math = obj.ctor !== 'Tex';

  const setLatex = (v: string) => setEq(obj.id, (o) => {
    if (o.eq?.parts?.length) writeParts(o, mergeTerms(o.eq.parts, splitTerms(v)));
    else o.args['*'] = quote(v);
  }, 'latex');
  const selectTerms = (ids: string[]) => setState({ selection: { kind: 'object', id: obj.id, terms: ids } });
  const toggle = (id: string, multi: boolean) => selectTerms(multi ? (terms.includes(id) ? terms.filter((t) => t !== id) : [...terms, id]) : terms.length === 1 && terms[0] === id ? [] : [id]);

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await api.checkEquation(split ? parts.map((p) => p.tex) : [latex], obj.ctor));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => setCheck(null), [latex]);

  const merge = () => setEq(obj.id, (o) => {
    const ps = o.eq!.parts;
    const idx = ps.map((p, i) => (terms.includes(p.id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) return;
    const lo = Math.min(...idx), hi = Math.max(...idx);
    const mergedPart: EqPart = { ...ps[lo], tex: ps.slice(lo, hi + 1).map((p) => p.tex).join(' ') };
    writeParts(o, [...ps.slice(0, lo), mergedPart, ...ps.slice(hi + 1)]);
  }, 'merge');
  const splitSelected = () => setEq(obj.id, (o) => {
    const out: EqPart[] = [];
    for (const p of o.eq!.parts) {
      if (!terms.includes(p.id)) {
        out.push(p);
        continue;
      }
      const pieces = splitFurther(p.tex);
      pieces.forEach((tex, k) => out.push(k === 0 ? { ...p, tex } : { id: Math.random().toString(36).slice(2, 9), tex, color: p.color }));
    }
    writeParts(o, out);
  }, 'split');

  return (
    <section className="fx-section equation">
      <h4>{math ? 'Equation' : 'LaTeX'}</h4>
      {editableLatex ? (
        <>
          {math && <MathField value={latex} onChange={setLatex} />}
          <Field multiline className="mono content" value={latex} onChange={setLatex} placeholder="LaTeX, e.g. a^2 + b^2 = c^2" />
        </>
      ) : (
        <p className="muted small">The text is a Python expression; edit it in the arguments below.</p>
      )}
      {!split ? (
        <button className="ghost small" disabled={!latex.trim()} title="Each symbol becomes a term (one manim submobject) you can color, brace, label and transform" onClick={() => setEq(obj.id, (o) => writeParts(o, splitTerms(latex).map((tex) => ({ id: Math.random().toString(36).slice(2, 9), tex }))), 'init')}>Split into terms</button>
      ) : (
        <>
          <div className="terms">
            {parts.map((p, i) => (
              <button key={p.id} className={`term ${terms.includes(p.id) ? 'on' : ''}`} style={p.color ? { borderBottomColor: colorFor(p.color) } : undefined}
                title={`Term ${i + 1}: ${p.tex}${check?.glyphs[i] === 0 ? ' (renders no glyphs)' : ''}. Click to select, Shift-click to add.`}
                onClick={(e) => toggle(p.id, e.shiftKey || e.metaKey || e.ctrlKey)}>
                <span className="mono">{termLabel(parts, i)}</span>
                {check && check.glyphs[i] === 0 && <span className="err-dot">!</span>}
              </button>
            ))}
          </div>
          <div className="row">
            <button className="ghost small" disabled={terms.length < 2} onClick={merge}>Merge</button>
            <button className="ghost small" disabled={!terms.length} onClick={splitSelected}>Split</button>
            <button className="ghost small" onClick={() => selectTerms(parts.map((p) => p.id))}>All</button>
            <button className="ghost small" title="Back to a single string (term styling is dropped)" onClick={() => setEq(obj.id, (o) => {
              o.args['*'] = quote(joinTerms(o.eq!.parts));
              delete o.eq;
            }, 'unsplit')}>Unsplit</button>
          </div>
          {terms.length > 0 && (
            <div className="param">
              <span className="pname">term color</span>
              <ColorField value={parts.find((p) => p.id === terms[0])?.color ?? ''} onChange={(c) => colorTerms(obj.id, terms, c)} placeholder="inherit" />
            </div>
          )}
          <p className="muted small">Repeated symbols are separate terms (#1, #2…), so you choose exactly which occurrence to style or match. Click terms on the canvas too.</p>
        </>
      )}
      <div className="row">
        <button className="ghost small" disabled={checking || !latex.trim()} onClick={() => void runCheck()}>{checking ? 'Checking…' : 'Check with manim'}</button>
        {check && (check.ok ? <span className="ok-text small">Renders: {check.glyphs.reduce((a, b) => a + b, 0)} glyphs{check.glyphs.includes(0) ? ', but some terms are empty' : ''}</span> : <span className="err-text small">{check.error}</span>)}
      </div>
      {check?.ok && check.glyphs.includes(0) && <p className="warn small">Terms marked ! render nothing on their own (e.g. a lone brace), so they can't be colored or matched. Merge them with a neighbour.</p>}
    </section>
  );
}

/** Split a term into its base and scripts, or into single tokens. */
function splitFurther(tex: string): string[] {
  const m = tex.match(/^(.*?)([_^].*)$/);
  if (m && m[1]) return [m[1], m[2]];
  const inner = splitTerms(tex.replace(/^\{([\s\S]*)\}$/, '$1'));
  return inner.length > 1 ? inner : [tex];
}

function colorFor(c: string): string {
  const table = getState().catalog?.color_hex ?? {};
  const s = c.replace(/^["']|["']$/g, '');
  return /^#/.test(s) ? s : table[s] ?? '#fff';
}

/** Source/destination views with editable term correspondence for a TransformTerms animation. */
export function TermsClipEditor({ anim: clip, onChange }: { anim: Anim; onChange: (fn: (c: Anim) => void) => void }) {
  const doc = useStore((s) => s.doc);
  const src = doc.objects.find((o) => o.name === clip.target);
  const dst = doc.objects.find((o) => o.id === clip.terms?.to);
  const [pick, setPick] = useState<string | null>(null);
  const equations = doc.objects.filter((o) => geoType(o, doc) === 'equation' && o.eq?.parts?.length && o.id !== src?.id);
  const pairs = clip.terms?.pairs ?? [];
  const sp = src?.eq?.parts ?? [];
  const dp = dst?.eq?.parts ?? [];
  const colorOf = (sid: string) => `hsl(${(pairs.findIndex((p) => p[0] === sid) * 67) % 360} 70% 60%)`;
  const pairOf = (side: 0 | 1, id: string) => pairs.filter((p) => p[side] === id);
  const clickSrc = (id: string) => setPick(pick === id ? null : id);
  const clickDst = (id: string) => {
    if (!pick) return;
    onChange((c) => {
      const t = (c.terms ??= { to: dst!.id, pairs: [] });
      const exists = t.pairs.some((p) => p[0] === pick && p[1] === id);
      t.pairs = exists ? t.pairs.filter((p) => !(p[0] === pick && p[1] === id)) : [...t.pairs, [pick, id]];
    });
    setPick(null);
  };
  return (
    <section className="fx-section terms-editor">
      <h4>Term correspondence</h4>
      {!src?.eq?.parts?.length && <p className="warn small">The source ({clip.target}) must be an equation split into terms.</p>}
      <div className="fx-row wide-row">
        <span>into</span>
        <select className="field mono" value={dst?.id ?? ''} onChange={(e) => onChange((c) => void (c.terms = { to: e.target.value, pairs: [] }))}>
          <option value="">— destination equation —</option>
          {equations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      {src && dst && (
        <>
          <div className="terms-view">
            <span className="muted small">{src.name}</span>
            <div className="terms">
              {sp.map((p, i) => {
                const paired = pairOf(0, p.id).length > 0;
                return <button key={p.id} className={`term ${pick === p.id ? 'on' : ''}`} style={paired ? { borderColor: colorOf(p.id) } : undefined} onClick={() => clickSrc(p.id)}><span className="mono">{termLabel(sp, i)}</span></button>;
              })}
            </div>
            <span className="muted small">{dst.name}</span>
            <div className="terms">
              {dp.map((p, i) => {
                const from = pairOf(1, p.id);
                return <button key={p.id} className={`term ${pick ? 'target' : ''}`} style={from.length ? { borderColor: colorOf(from[0][0]) } : undefined} onClick={() => clickDst(p.id)}><span className="mono">{termLabel(dp, i)}</span></button>;
              })}
            </div>
          </div>
          <p className="muted small">{pick ? 'Now click the destination term it becomes (click a paired one again to unpair).' : 'Click a source term, then the destination term it becomes. Unpaired terms fade out or in.'}</p>
          <div className="row">
            <button className="ghost small" onClick={() => onChange((c) => void (c.terms = { to: dst.id, pairs: autoPairs(sp, dp) }))}>Pair identical terms</button>
            <button className="ghost small" disabled={!pairs.length} onClick={() => onChange((c) => void (c.terms = { to: dst.id, pairs: [] }))}>Clear</button>
          </div>
          <p className="muted small">Pairs: {pairs.length ? pairs.map(([a, b]) => `${sp.find((p) => p.id === a)?.tex ?? '?'} → ${dp.find((p) => p.id === b)?.tex ?? '?'}`).join(', ') : 'none'}</p>
          <p className="note small">This only says how terms move on screen. It does not check that the two equations are mathematically equivalent.</p>
        </>
      )}
    </section>
  );
}
