import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { askPath } from '../api';
import { evalNumber, evalVector, fmtNum, formatDict, formatVector, parseDict, parseList, pyQuote, pyString, splitTop } from '../pyparse';
import { ensureSignature, getState, useSignature, useStore } from '../store';
import type { Param, ParamKind } from '../types';
import { ratePath } from './rates';

/** Text input that keeps local state while typing and commits on every change. */
export function Field({ value, onChange, placeholder, className, list, multiline, onBlur }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  list?: string;
  multiline?: boolean;
  onBlur?: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const props = {
    value: local,
    placeholder,
    className: `field ${className ?? ''}`,
    spellCheck: false,
    onChange: (e: { target: { value: string } }) => {
      setLocal(e.target.value);
      onChange(e.target.value);
    },
    onBlur: () => onBlur?.(local),
  };
  return multiline ? <textarea {...props} rows={Math.min(14, Math.max(2, local.split('\n').length + 1))} /> : <input {...props} list={list} />;
}

/** Premiere-style "scrubby" number: drag horizontally to change, click to type. */
export function ScrubNumber({ value, onChange, step = 0.05, precision = 2, suffix = '', min, max, placeholder }: {
  value: number | null;
  onChange: (v: number) => void;
  step?: number;
  precision?: number;
  suffix?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const clampV = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const fmtV = (v: number) => String(Math.round(v * 10 ** precision) / 10 ** precision);
  if (editing !== null)
    return (
      <input
        className="field num scrub-edit"
        autoFocus
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => {
          const n = parseFloat(editing);
          if (!Number.isNaN(n)) onChange(clampV(n));
          setEditing(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(null);
        }}
      />
    );
  return (
    <span
      className={`scrub ${value === null ? 'unset' : ''}`}
      title="Drag to change · click to type · Shift = ×10, Alt = ÷10"
      onPointerDown={(e) => {
        e.preventDefault();
        const x0 = e.clientX;
        const v0 = value ?? 0;
        let moved = false;
        const move = (ev: PointerEvent) => {
          const dx = ev.clientX - x0;
          if (Math.abs(dx) > 2) moved = true;
          if (!moved) return;
          const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
          onChange(clampV(Number(fmtV(v0 + dx * step * k))));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', () => {
          window.removeEventListener('pointermove', move);
          if (!moved) setEditing(value === null ? '' : fmtV(value));
        }, { once: true });
      }}
    >
      {value === null ? placeholder ?? '—' : fmtV(value) + suffix}
    </span>
  );
}

const MAIN_COLORS = ['WHITE', 'GREY', 'BLACK', 'BLUE', 'TEAL', 'GREEN', 'YELLOW', 'GOLD', 'ORANGE', 'RED', 'MAROON', 'PURPLE', 'PINK', 'LIGHT_BROWN', 'DARK_BROWN'];
const SHADES = ['BLUE', 'TEAL', 'GREEN', 'YELLOW', 'GOLD', 'RED', 'MAROON', 'PURPLE', 'GREY'];

/** Color swatch that opens a picker with the manim palette, a hex field and the system picker. */
export function ColorField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const table = useStore((s) => s.catalog?.color_hex ?? {});
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const hex = colorHex(value || placeholder || '', table);
  const pick = (v: string) => onChange(v);
  const rect = btn.current?.getBoundingClientRect();
  return (
    <div className="row color-field">
      <button ref={btn} className={`swatch ${hex ? '' : 'none'}`} style={{ background: hex ?? undefined }} onClick={() => setOpen(!open)} title="Pick a color" />
      <Field value={value} onChange={onChange} placeholder={placeholder} list="me-colors" className="mono" />
      {open && rect && createPortal(
        <>
          <div className="popover-back" onPointerDown={() => setOpen(false)} />
          <div className="color-pop" style={{ top: Math.min(rect.bottom + 6, window.innerHeight - 300), left: Math.max(8, rect.right - 250) }}>
            <div className="cp-grid main">
              {MAIN_COLORS.filter((n) => table[n]).map((n) => (
                <button key={n} className={`cp-sw ${value === n ? 'on' : ''}`} style={{ background: table[n] }} title={n} onClick={() => pick(n)} />
              ))}
            </div>
            <div className="cp-shades">
              {SHADES.map((base) => (
                <div key={base} className="cp-grid">
                  {['A', 'B', 'C', 'D', 'E'].map((sh) => `${base}_${sh}`).filter((n) => table[n]).map((n) => (
                    <button key={n} className={`cp-sw ${value === n ? 'on' : ''}`} style={{ background: table[n] }} title={n} onClick={() => pick(n)} />
                  ))}
                </div>
              ))}
            </div>
            <div className="row">
              <input type="color" className="cp-native" value={hex ?? '#ffffff'} onChange={(e) => pick(`"${e.target.value.toUpperCase()}"`)} />
              <span className="mono small">{hex ?? 'none'}</span>
              <div className="spacer" />
              <button className="ghost small" onClick={() => { onChange(''); setOpen(false); }}>default</button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export const isColorKey = (name: string) => /(^|_)colou?r$/i.test(name);

/** Kinds edited by a structured widget; all of them can flip to raw Python with the {} toggle. */
const STRUCTURED = new Set<ParamKind>(['vector', 'choice', 'mobject', 'mobjects', 'range', 'numbers', 'strings', 'colors', 'colormap', 'dict', 'points', 'matrix', 'string', 'path',
  'values', 'pairs', 'vertex', 'animation', 'dicts', 'svgpath']);

/** Drag step for a numeric parameter, guessed from its name. */
export function numStep(name: string, int?: boolean): number {
  if (int || /(^|_)(n|num|count|index|resolution|font_size|tab_width|decimal_places|places)(_|$)/.test(name)) return 1;
  if (/opacity|ratio|alpha|proportion|fraction|factor|lag|sheen/.test(name)) return 0.01;
  if (/angle|arc|theta|phi|radians/.test(name)) return Math.PI / 180;
  return 0.02;
}

/** Pointer handler that scrubs a number by dragging horizontally (Shift ×10, Alt ÷10). */
export function scrubber(start: () => number, step: number, apply: (v: number) => void, int = false) {
  return (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = start();
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const v = v0 + (ev.clientX - x0) * step * k;
      apply(int ? Math.round(v) : Number(fmtNum(v, step < 0.01 ? 4 : 3)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  };
}

function useObjectNames(accepts?: string[]): string[] {
  const objects = useStore((s) => s.doc.objects);
  const base = useStore((s) => s.doc.scene.base);
  const signatures = useStore((s) => s.signatures);
  const ok = accepts?.length ? new Set(accepts) : null;
  const names = objects
    .filter((o) => {
      if (!ok) return true;
      // An object's class: its constructor, or what a factory like axes.plot returns. Unknown -> keep.
      const sig = signatures[o.ctor];
      if (!sig) ensureSignature(o.ctor);
      const cls = sig?.returns || (/^[A-Za-z_]\w*$/.test(o.ctor) ? o.ctor : '');
      return !cls || sig?.unknown || ok.has(cls) || !getState().catalog?.mobjects.some((m) => m.name === cls);
    })
    .map((o) => o.name);
  if (['MovingCameraScene', 'ZoomedScene'].includes(base) && (!ok || ok.has('ScreenRectangle') || ok.has('Rectangle'))) names.push('self.camera.frame');
  return names;
}

/** Whether `value` can be shown in the structured widget for `kind` (else raw Python is shown). */
function structurable(param: Param, value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  const star = param.name === '*';
  switch (param.kind) {
    case 'string': case 'path': return pyString(v) !== null;
    case 'vector': return true;
    case 'range': { const l = parseList(v); return !!l && l.length <= 3; }
    case 'mobjects': {
      const names = new Set(snapshotNames());
      const items = star ? splitTop(v) : parseList(v);
      return !!items && items.every((x) => names.has(x));
    }
    case 'numbers': case 'colors': case 'points': case 'strings':
      return (star ? splitTop(v) : parseList(v)) !== null && (param.kind !== 'strings' || (parseList(v) ?? []).every((x) => pyString(x) !== null));
    case 'colormap': case 'dict': return parseDict(v) !== null;
    case 'matrix': { const rows = parseList(v); return !!rows && rows.every((r) => parseList(r) !== null); }
    case 'values': return (star ? splitTop(v) : parseList(v)) !== null;
    case 'pairs': { const items = star ? splitTop(v) : parseList(v); return !!items && items.every((x) => parseList(x)?.length === 2); }
    case 'dicts': { const items = parseList(v); return !!items && items.every((x) => parseDict(x) !== null); }
    case 'animation': return /^\w+\(\s*[\w.]*\s*\)$/.test(v);
    case 'svgpath': return /^se\.Path\(([\s\S]*)\)$/.test(v) && pyString(v.slice(8, -1)) !== null;
    default: return true;
  }
}
function snapshotNames() {
  return getState().doc.objects.map((o) => o.name).concat('self.camera.frame');
}

export function ParamField({ param, value, onChange, onRemove, siblings }: { param: Param; value: string; onChange: (v: string) => void; onRemove?: () => void; siblings?: Record<string, string> }) {
  const [rawMode, setRaw] = useState(false);
  const kind: ParamKind = isColorKey(param.name) && param.kind === 'expr' ? 'color' : param.kind;
  const p = kind === param.kind ? param : { ...param, kind };
  const canStructure = structurable(p, value);
  const raw = STRUCTURED.has(kind) && (rawMode || !canStructure);
  const placeholder = param.default || (param.required ? 'required' : '');
  const step = numStep(param.name, param.int);
  const scrub = kind === 'number' && !raw
    ? scrubber(() => evalNumber(value) ?? evalNumber(param.default) ?? 0, step, (v) => onChange(String(v)), param.int || step === 1)
    : undefined;
  return (
    <div className={`param ${param.required && !value ? 'missing' : ''} ${STRUCTURED.has(kind) && !['string', 'path', 'choice', 'mobject', 'vertex', 'svgpath'].includes(kind) ? 'wide' : ''}`}
      title={param.annotation ? `${param.label}: ${param.annotation}${param.from ? `  (from ${param.from})` : ''}` : param.label}>
      <span className={`pname ${scrub ? 'scrubbable' : ''}`} onPointerDown={scrub} title={scrub ? 'Drag to change · Shift ×10 · Alt ÷10' : undefined}>
        {param.label}
        {onRemove && <button className="x-btn" title="Remove" onClick={onRemove}>×</button>}
      </span>
      <div className="pcontrol">
        {raw ? <Field value={value} onChange={onChange} placeholder={placeholder} className="mono" /> : <Control param={p} value={value} onChange={onChange} placeholder={placeholder} siblings={siblings} />}
        {STRUCTURED.has(kind) && (
          <button className={`raw-toggle ${raw ? 'on' : ''}`} disabled={!canStructure} title={raw ? (canStructure ? 'Back to the visual editor' : 'This value is custom Python') : 'Edit as Python'} onClick={() => setRaw(!rawMode)}>{'{}'}</button>
        )}
      </div>
    </div>
  );
}

function Control({ param, value, onChange, placeholder, siblings }: { param: Param; value: string; onChange: (v: string) => void; placeholder: string; siblings?: Record<string, string> }) {
  const catalog = useStore((s) => s.catalog);
  switch (param.kind) {
    case 'bool':
      return (
        <div className="seg">
          {(['', 'True', 'False'] as const).map((b) => (
            <button key={b} className={value === b ? 'on' : ''} title={b ? undefined : `manim default${param.default ? ` (${param.default})` : ''}`} onClick={() => onChange(b)}>
              {b || (param.default === 'True' || param.default === 'False' ? `auto·${param.default[0]}` : 'auto')}
            </button>
          ))}
        </div>
      );
    case 'color':
      return <ColorField value={value} onChange={onChange} placeholder={placeholder} />;
    case 'rate_func':
      return (
        <div className="row">
          <svg className="rate-icon" viewBox="0 0 24 16"><path d={ratePath(value || param.default || 'smooth', 24, 16)} /></svg>
          <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">default ({param.default || '—'})</option>
            {catalog?.rate_funcs.map((r) => <option key={r} value={r}>{r}</option>)}
            {value && !catalog?.rate_funcs.includes(value) && <option value={value}>{value}</option>}
          </select>
        </div>
      );
    case 'number':
      return <NumberControl param={param} value={value} onChange={onChange} placeholder={placeholder} />;
    case 'vector':
      return <VectorField value={value} onChange={onChange} placeholder={placeholder} objects={param.objects} />;
    case 'choice':
      return <ChoiceField options={param.options ?? []} value={value} onChange={onChange} def={param.default} />;
    case 'mobject':
      return <MobjectField value={value} onChange={onChange} def={param.default} accepts={param.accepts} />;
    case 'mobjects':
      return <MobjectsField value={value} onChange={onChange} star={param.name === '*'} accepts={param.accepts} />;
    case 'range':
      return <RangeField value={value} onChange={onChange} def={param.default} />;
    case 'numbers': case 'strings': case 'colors': case 'points':
      return <ListField kind={param.kind} value={value} onChange={onChange} star={param.name === '*'} def={param.default} />;
    case 'colormap':
      return <ColorMapField value={value} onChange={onChange} />;
    case 'dict':
      return <DictField value={value} onChange={onChange} hint={param.hint} def={param.default} />;
    case 'matrix':
      return <MatrixField value={value} onChange={onChange} />;
    case 'values':
      return <ValuesField value={value} onChange={onChange} star={param.name === '*'} def={param.default} />;
    case 'pairs':
      return <PairsField value={value} onChange={onChange} star={param.name === '*'} vertices={vertexOptions(siblings)} />;
    case 'vertex': {
      const opts = vertexOptions(siblings);
      return opts.length ? <ChoiceField options={opts} value={value} onChange={onChange} def={param.default} /> : <Field value={value} onChange={onChange} placeholder="vertex label" className="mono" />;
    }
    case 'key':
      return <Field value={value} onChange={onChange} placeholder={placeholder || 'key (e.g. "a" or 1)'} className="mono" />;
    case 'animation':
      return <AnimationField value={value} onChange={onChange} />;
    case 'dicts':
      return <DictsField value={value} onChange={onChange} hint={param.hint} />;
    case 'svgpath': {
      const d = value ? pyString(value.slice(8, -1)) ?? '' : '';
      return <Field value={d} onChange={(t) => onChange(t ? `se.Path(${pyQuote(t)})` : '')} placeholder="SVG path data, e.g. M 0 0 C 1 2 3 2 4 0" className="mono" />;
    }
    case 'string':
      return <Field value={pyString(value) ?? value} onChange={(t) => onChange(t === '' ? '' : pyQuote(t))} placeholder={pyString(param.default) ?? placeholder} />;
    case 'path':
      return (
        <div className="row">
          <Field value={pyString(value) ?? value} onChange={(t) => onChange(t === '' ? '' : pyQuote(t))} placeholder={placeholder || 'file path'} />
          <button className="ghost small" onClick={async () => { const f = await askPath('open', '', [], 'File path:'); if (f) onChange(pyQuote(f)); }}>Browse</button>
        </div>
      );
    case 'function':
      return (
        <div className="row">
          <Field value={value} onChange={onChange} placeholder={param.template ?? placeholder} className="mono" />
          {!value && param.template && <button className="ghost small" title={`Insert ${param.template}`} onClick={() => onChange(param.template!)}>λ</button>}
        </div>
      );
    default:
      return <Field value={value} onChange={onChange} placeholder={placeholder} className="mono" />;
  }
}

function NumberControl({ param, value, onChange, placeholder }: { param: Param; value: string; onChange: (v: string) => void; placeholder: string }) {
  const unit = /opacity|alpha|proportion/.test(param.name) && !param.int;
  const n = evalNumber(value) ?? evalNumber(param.default);
  return (
    <div className="row">
      {unit && <input type="range" className="slider" min={0} max={1} step={0.01} value={n ?? 0} onChange={(e) => onChange(e.target.value)} />}
      <Field value={value} onChange={onChange} placeholder={placeholder} className={`num ${unit ? 'narrow' : ''}`} />
    </div>
  );
}

const COMPASS = [['UL', 'UP', 'UR'], ['LEFT', 'ORIGIN', 'RIGHT'], ['DL', 'DOWN', 'DR']];
const ARROWS: Record<string, string> = { UL: '↖', UP: '↑', UR: '↗', LEFT: '←', ORIGIN: '•', RIGHT: '→', DL: '↙', DOWN: '↓', DR: '↘', IN: '⊗', OUT: '⊙' };

/** Point/direction: compass presets, draggable x/y/z, raw expression, or (optionally) an object. */
export function VectorField({ value, onChange, placeholder, objects }: { value: string; onChange: (v: string) => void; placeholder?: string; objects?: boolean }) {
  const names = useObjectNames();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const vec = evalVector(value) ?? (value.trim() ? null : evalVector(placeholder ?? ''));
  const isObj = names.includes(value.trim());
  const set = (i: number, x: number) => {
    const v = [...(vec ?? [0, 0, 0])];
    while (v.length < 3) v.push(0);
    v[i] = x;
    onChange(formatVector(v));
  };
  const rect = btn.current?.getBoundingClientRect();
  return (
    <div className="vec-field">
      <div className="row">
        <button ref={btn} className="compass-btn" title="Direction presets" onClick={() => setOpen(!open)}>{ARROWS[value.trim()] ?? '✥'}</button>
        <Field value={value} onChange={onChange} placeholder={placeholder} list={objects ? 'me-points' : 'me-directions'} className="mono" />
      </div>
      {vec && !isObj && (
        <div className="row vec-xyz">
          {['x', 'y', 'z'].map((axis, i) => (
            <span key={axis} className="vec-comp"><span className="muted">{axis}</span><ScrubNumber value={vec[i] ?? 0} step={0.02} precision={3} onChange={(x) => set(i, x)} /></span>
          ))}
        </div>
      )}
      {open && rect && createPortal(
        <>
          <div className="popover-back" onPointerDown={() => setOpen(false)} />
          <div className="compass-pop" style={{ top: Math.min(rect.bottom + 4, window.innerHeight - 200), left: Math.max(8, rect.left) }}>
            {COMPASS.map((row) => row.map((d) => (
              <button key={d} title={d} className={value.trim() === d ? 'on' : ''} onClick={() => { onChange(d); setOpen(false); }}>{ARROWS[d]}</button>
            )))}
            <button title="IN" onClick={() => { onChange('IN'); setOpen(false); }}>{ARROWS.IN}</button>
            <button title="OUT" onClick={() => { onChange('OUT'); setOpen(false); }}>{ARROWS.OUT}</button>
            <button title="default" onClick={() => { onChange(''); setOpen(false); }}>∅</button>
            {objects && names.map((n) => (
              <button key={n} className={`obj ${value.trim() === n ? 'on' : ''}`} onClick={() => { onChange(n); setOpen(false); }}>{n}</button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export function ChoiceField({ options, value, onChange, def }: { options: string[]; value: string; onChange: (v: string) => void; def?: string }) {
  return (
    <select className="field mono" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">default{def ? ` (${def})` : ''}</option>
      {options.map((o) => <option key={o} value={o}>{pyString(o) ?? o}</option>)}
      {value && !options.includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}

function MobjectField({ value, onChange, def, accepts }: { value: string; onChange: (v: string) => void; def?: string; accepts?: string[] }) {
  const names = useObjectNames(accepts);
  return (
    <select className="field mono" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{def && def !== 'None' ? `default (${def})` : '— none —'}</option>
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
      {value && !names.includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}

function MobjectsField({ value, onChange, star, accepts }: { value: string; onChange: (v: string) => void; star: boolean; accepts?: string[] }) {
  const names = useObjectNames(accepts).filter((n) => n !== 'self.camera.frame');
  const items = (star ? splitTop(value) : parseList(value) ?? []).filter(Boolean);
  const toggle = (n: string) => {
    const next = items.includes(n) ? items.filter((x) => x !== n) : [...items, n];
    onChange(next.length ? (star ? next.join(', ') : `[${next.join(', ')}]`) : '');
  };
  return (
    <div className="chips">
      {names.length === 0 && <span className="muted small">{accepts?.length ? `no ${accepts.slice(0, 3).join('/')} objects yet` : 'no objects yet'}</span>}
      {names.map((n) => <button key={n} className={`chip ${items.includes(n) ? 'on' : ''}`} onClick={() => toggle(n)}>{n}</button>)}
    </div>
  );
}

/** Small text box whose label scrubs it when the value is numeric. */
function NumBox({ label, value, onChange, placeholder, step = 0.05 }: { label?: string; value: string; onChange: (v: string) => void; placeholder?: string; step?: number }) {
  const start = () => evalNumber(value) ?? evalNumber(placeholder ?? '') ?? 0;
  return (
    <span className="numbox">
      {label !== undefined && <span className="scrubbable muted" onPointerDown={scrubber(start, step, (v) => onChange(String(v)))}>{label}</span>}
      <Field value={value} onChange={onChange} placeholder={placeholder} className="num" />
    </span>
  );
}

function RangeField({ value, onChange, def }: { value: string; onChange: (v: string) => void; def: string }) {
  const items = parseList(value) ?? [];
  const defs = parseList(def) ?? [];
  const set = (i: number, v: string) => {
    const next = [0, 1, 2].map((k) => (k === i ? v : items[k] ?? ''));
    if (!next[2]) next.pop();
    if (next.every((x) => !x)) return onChange('');
    onChange(`[${next.map((x, k) => x || defs[k] || (k === 2 ? '1' : '0')).join(', ')}]`);
  };
  return (
    <div className="row range-field">
      {['min', 'max', 'step'].map((l, i) => <NumBox key={l} label={l} value={items[i] ?? ''} placeholder={defs[i] ?? (i === 2 ? 'auto' : '')} step={i === 2 ? 0.05 : 0.1} onChange={(v) => set(i, v)} />)}
    </div>
  );
}

function ListField({ kind, value, onChange, star, def }: { kind: 'numbers' | 'strings' | 'colors' | 'points'; value: string; onChange: (v: string) => void; star: boolean; def: string }) {
  const items = (star ? splitTop(value) : parseList(value) ?? []).filter((x, i, a) => x || i < a.length - 1);
  const write = (next: string[]) => onChange(next.length ? (star ? next.join(', ') : `[${next.join(', ')}]`) : '');
  const set = (i: number, v: string) => write(items.map((x, k) => (k === i ? v : x)));
  const fresh = { numbers: '0', strings: '""', colors: 'WHITE', points: 'ORIGIN' }[kind];
  return (
    <div className="list-field">
      {items.length === 0 && <span className="muted small">{def && def !== 'None' ? `default ${def}` : 'empty'}</span>}
      {items.map((it, i) => (
        <div key={i} className="row list-row">
          <span className="muted small idx">{i}</span>
          {kind === 'numbers' && <NumBox value={it} onChange={(v) => set(i, v)} label="⇔" step={0.1} />}
          {kind === 'strings' && <Field value={pyString(it) ?? it} onChange={(t) => set(i, pyQuote(t))} />}
          {kind === 'colors' && <ColorField value={it} onChange={(v) => set(i, v || 'WHITE')} />}
          {kind === 'points' && <VectorField value={it} onChange={(v) => set(i, v || 'ORIGIN')} />}
          <button className="x-btn" title="Remove" onClick={() => write(items.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => write([...items, kind === 'points' && items.length ? items[items.length - 1] : fresh])}>+ add</button>
    </div>
  );
}

function ColorMapField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const items = parseDict(value) ?? [];
  const write = (next: [string, string][]) => onChange(formatDict(next));
  return (
    <div className="list-field">
      {items.map(([k, v], i) => (
        <div key={i} className="row list-row">
          <Field value={pyString(k) ?? k} placeholder="text" onChange={(t) => write(items.map((x, j) => (j === i ? [pyQuote(t), x[1]] : x)))} />
          <ColorField value={v} onChange={(c) => write(items.map((x, j) => (j === i ? [x[0], c || 'WHITE'] : x)))} />
          <button className="x-btn" onClick={() => write(items.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => write([...items, ['"x"', 'YELLOW']])}>+ color a substring</button>
    </div>
  );
}

function DictField({ value, onChange, hint, def }: { value: string; onChange: (v: string) => void; hint?: string; def: string }) {
  const sig = useSignature(hint ?? '');
  const items = parseDict(value) ?? [];
  const [newKey, setNewKey] = useState('');
  const write = (next: [string, string][]) => onChange(formatDict(next));
  const keyName = (k: string) => pyString(k) ?? k;
  const used = new Set(items.map(([k]) => keyName(k)));
  const hintParams = (sig?.params ?? []).filter((p) => p.name !== '*');
  const add = (k: string) => {
    if (!k || used.has(k)) return;
    const p = hintParams.find((x) => x.name === k);
    write([...items, [JSON.stringify(k), p?.default && p.default !== 'None' ? p.default : 'None']]);
    setNewKey('');
  };
  return (
    <div className="dict-field">
      {items.length === 0 && <span className="muted small">{def && def !== 'None' && def !== '{}' ? `default ${def}` : 'no keys set'}</span>}
      {items.map(([k, v], i) => {
        const name = keyName(k);
        const p = hintParams.find((x) => x.name === name) ?? { name, label: name, kind: 'expr' as ParamKind, default: '', required: false, annotation: '', from: '' };
        return (
          <ParamField key={k + i} param={{ ...p, required: false }} value={v} onChange={(nv) => write(items.map((x, j) => (j === i ? [x[0], nv || 'None'] : x)))}
            onRemove={() => write(items.filter((_, j) => j !== i))} />
        );
      })}
      <div className="row">
        {hintParams.length > 0 ? (
          <select className="field mono" value="" onChange={(e) => add(e.target.value)}>
            <option value="">+ {hint} option…</option>
            {hintParams.filter((p) => !used.has(p.name)).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        ) : (
          <>
            <input className="field mono" placeholder="key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            <button className="ghost small" disabled={!newKey.trim()} onClick={() => add(newKey.trim())}>+ key</button>
          </>
        )}
      </div>
    </div>
  );
}

function MatrixField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rows = (parseList(value) ?? []).map((r) => parseList(r) ?? [r]);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const grid = rows.length ? rows.map((r) => Array.from({ length: cols }, (_, j) => r[j] ?? '0')) : [];
  const write = (g: string[][]) => onChange(g.length ? `[${g.map((r) => `[${r.join(', ')}]`).join(', ')}]` : '');
  return (
    <div className="matrix-field">
      <div className="matrix-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {grid.map((r, i) => r.map((c, j) => (
          <Field key={`${i}-${j}`} value={c} className="mono num" onChange={(v) => write(grid.map((rr, a) => rr.map((cc, b) => (a === i && b === j ? v || '0' : cc))))} />
        )))}
      </div>
      <div className="row">
        <button className="ghost small" onClick={() => write([...grid, Array(grid.length ? cols : 2).fill('0')])}>+ row</button>
        <button className="ghost small" disabled={!grid.length} onClick={() => write(grid.map((r) => [...r, '0']))}>+ col</button>
        <button className="ghost small" disabled={!grid.length} onClick={() => write(grid.slice(0, -1))}>− row</button>
        <button className="ghost small" disabled={cols < 2} onClick={() => write(grid.map((r) => r.slice(0, -1)))}>− col</button>
      </div>
    </div>
  );
}


/** Vertex labels declared in a sibling `vertices` argument (Graph edges / root_vertex pick from them). */
function vertexOptions(siblings?: Record<string, string>): string[] {
  const src = siblings?.vertices;
  return src ? parseList(src) ?? [] : [];
}

function ValuesField({ value, onChange, star, def }: { value: string; onChange: (v: string) => void; star: boolean; def: string }) {
  const items = (star ? splitTop(value) : parseList(value) ?? []).filter(Boolean);
  const write = (next: string[]) => onChange(next.length ? (star ? next.join(', ') : `[${next.join(', ')}]`) : '');
  const nums = items.map((x) => evalNumber(x)).filter((x): x is number => x !== null);
  const fresh = items.length === 0 ? '1' : nums.length === items.length ? String(Math.max(...nums) + 1) : '""';
  return (
    <div className="list-field">
      {items.length === 0 && <span className="muted small">{def && def !== 'None' ? `default ${def}` : 'empty'}</span>}
      <div className="chips">
        {items.map((it, i) => (
          <span key={i} className="chip value-chip">
            <Field value={it} className="mono" onChange={(v) => write(items.map((x, k) => (k === i ? v || '0' : x)))} />
            <button className="x-btn" onClick={() => write(items.filter((_, k) => k !== i))}>×</button>
          </span>
        ))}
        <button className="ghost small" onClick={() => write([...items, fresh])}>+ add</button>
      </div>
    </div>
  );
}

function PairsField({ value, onChange, star, vertices }: { value: string; onChange: (v: string) => void; star: boolean; vertices: string[] }) {
  const items = (star ? splitTop(value) : parseList(value) ?? []).filter(Boolean).map((x) => parseList(x) ?? ['', '']);
  const write = (next: string[][]) => {
    const parts = next.map(([a, b]) => `(${a || '0'}, ${b || '0'})`);
    onChange(parts.length ? (star ? parts.join(', ') : `[${parts.join(', ')}]`) : '');
  };
  const end = (i: number, j: number, v: string) => write(items.map((pr, k) => (k === i ? pr.map((x, q) => (q === j ? v : x)) : pr)));
  const pick = (v: string, set: (v: string) => void) => vertices.length
    ? <select className="field mono" value={v} onChange={(e) => set(e.target.value)}>{[...new Set([...vertices, v])].map((o) => <option key={o} value={o}>{o}</option>)}</select>
    : <Field value={v} className="mono" onChange={set} />;
  return (
    <div className="list-field">
      {items.map(([a, b], i) => (
        <div key={i} className="row list-row">
          {pick(a, (v) => end(i, 0, v))}<span className="muted">—</span>{pick(b, (v) => end(i, 1, v))}
          <button className="x-btn" onClick={() => write(items.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => write([...items, [vertices[0] ?? '1', vertices[1] ?? vertices[0] ?? '2']])}>+ edge</button>
    </div>
  );
}

function AnimationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const catalog = useStore((s) => s.catalog);
  const names = useObjectNames();
  const m = value.match(/^(\w+)\(\s*([\w.]*)\s*\)$/);
  const [cls, target] = m ? [m[1], m[2]] : ['', ''];
  const write = (c: string, t: string) => onChange(c ? `${c}(${t})` : '');
  return (
    <div className="row">
      <select className="field mono" value={cls} onChange={(e) => write(e.target.value, target || names[0] || '')}>
        <option value="">— animation —</option>
        {catalog?.animations.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
      </select>
      <select className="field mono" value={target} disabled={!cls} onChange={(e) => write(cls, e.target.value)}>
        {[...new Set([...names, target])].map((n) => <option key={n} value={n}>{n || '—'}</option>)}
      </select>
    </div>
  );
}

function DictsField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  const items = parseList(value) ?? [];
  const write = (next: string[]) => onChange(next.length ? `[${next.join(', ')}]` : '');
  return (
    <div className="list-field">
      {items.map((d, i) => (
        <div key={i} className="row list-row">
          <span className="muted small idx">{i}</span>
          <DictField value={d === '{}' ? '' : d} hint={hint} def="" onChange={(v) => write(items.map((x, k) => (k === i ? v || '{}' : x)))} />
          <button className="x-btn" onClick={() => write(items.filter((_, k) => k !== i))}>×</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => write([...items, '{}'])}>+ add</button>
    </div>
  );
}

export function colorHex(v: string, table: Record<string, string>): string | null {
  const s = v.trim().replace(/^["']|["']$/g, '');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  return table[s] ?? null;
}

/** Datalists shared by all fields. */
export function SharedLists() {
  const catalog = useStore((s) => s.catalog);
  const objects = useStore((s) => s.doc.objects);
  const base = useStore((s) => s.doc.scene.base);
  return (
    <>
      <datalist id="me-colors">{catalog?.colors.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="me-directions">{catalog?.directions.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="me-points">
        {catalog?.directions.map((c) => <option key={c} value={c} />)}
        {objects.map((o) => <option key={o.id} value={o.name} />)}
      </datalist>
      <datalist id="me-mobjects">{catalog?.mobjects.map((c) => <option key={c.name} value={c.name} />)}</datalist>
      <datalist id="me-animations">
        <option value="animate" />
        {catalog?.animations.map((c) => <option key={c.name} value={c.name} />)}
      </datalist>
      <datalist id="me-targets">
        {objects.map((o) => <option key={o.id} value={o.name} />)}
        {['MovingCameraScene', 'ZoomedScene'].includes(base) && <option value="self.camera.frame" />}
      </datalist>
    </>
  );
}

// Python string literal helpers for the "content" box of text mobjects.
export function unquote(src: string): string | null {
  const m = src.trim().match(/^([rR]?)("""|'''|"|')([\s\S]*)\2$/);
  if (!m || (!m[1] && m[3].includes('\\'))) return null; // escapes in a non-raw string: edit as code
  return m[3];
}

export function quote(text: string): string {
  if (text.endsWith('\\')) return JSON.stringify(text);
  if (text.includes('\n') || text.includes('"')) return text.includes('"""') ? JSON.stringify(text) : `r"""${text}"""`;
  return `r"${text}"`;
}
