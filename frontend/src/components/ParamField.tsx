import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import type { Param } from '../types';

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

export function ParamField({ param, value, onChange }: { param: Param; value: string; onChange: (v: string) => void }) {
  const catalog = useStore((s) => s.catalog);
  const placeholder = param.default || (param.required ? 'required' : '');
  let control;
  const kind = isColorKey(param.name) && param.kind === 'expr' ? 'color' : param.kind;
  switch (kind) {
    case 'bool':
      control = (
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">default ({param.default})</option>
          <option value="True">True</option>
          <option value="False">False</option>
        </select>
      );
      break;
    case 'color':
      control = <ColorField value={value} onChange={onChange} placeholder={placeholder} />;
      break;
    case 'rate_func':
      control = (
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">default ({param.default})</option>
          {catalog?.rate_funcs.map((r) => <option key={r} value={r}>{r}</option>)}
          {value && !catalog?.rate_funcs.includes(value) && <option value={value}>{value}</option>}
        </select>
      );
      break;
    case 'vector':
      control = <Field value={value} onChange={onChange} placeholder={placeholder} list="me-directions" />;
      break;
    case 'number':
      control = <Field value={value} onChange={onChange} placeholder={placeholder} className="num" />;
      break;
    default:
      control = <Field value={value} onChange={onChange} placeholder={placeholder} className="mono" />;
  }
  return (
    <label className={`param ${param.required && !value ? 'missing' : ''}`} title={param.annotation ? `${param.label}: ${param.annotation}` : param.label}>
      <span className="pname">{param.label}</span>
      {control}
    </label>
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
