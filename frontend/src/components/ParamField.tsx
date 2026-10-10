import { useEffect, useState } from 'react';
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

export function ParamField({ param, value, onChange }: { param: Param; value: string; onChange: (v: string) => void }) {
  const catalog = useStore((s) => s.catalog);
  const placeholder = param.default || (param.required ? 'required' : '');
  let control;
  switch (param.kind) {
    case 'bool':
      control = (
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">default ({param.default})</option>
          <option value="True">True</option>
          <option value="False">False</option>
        </select>
      );
      break;
    case 'color': {
      const hex = colorHex(value || param.default, catalog?.color_hex ?? {});
      control = (
        <div className="row">
          <input type="color" className="swatch" value={hex ?? '#ffffff'} onChange={(e) => onChange(`"${e.target.value.toUpperCase()}"`)} />
          <Field value={value} onChange={onChange} placeholder={placeholder} list="me-colors" />
        </div>
      );
      break;
    }
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
