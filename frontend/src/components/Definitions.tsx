// Scene › Definitions: named values, lists and functions written in math, not Python (mathengine/defs.py).

import { useEffect, useState } from 'react';
import { api } from '../api';
import { renameRefs } from '../construct';
import { renameIdentifiers, splitTop } from '../pyparse';
import { getState, toast, uid, updateDoc, useStore } from '../store';
import { renameInTimeline } from '../timeline';
import type { Def, DefInfo, SceneDoc } from '../types';
import { Field } from './ParamField';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** A name no definition or object has yet: `base`, base2, base3… */
function freeName(d: SceneDoc, base: string): string {
  const taken = new Set([...(d.defs ?? []).map((x) => x.name), ...d.objects.map((o) => o.name)]);
  for (let k = 1; ; k++) if (!taken.has(k === 1 ? base : `${base}${k}`)) return k === 1 ? base : `${base}${k}`;
}

export function addDef(kind: Def['kind']): string {
  const id = uid('d');
  updateDoc((d) => {
    const name = freeName(d, kind === 'value' ? 'c' : kind === 'list' ? 'data' : 'g');
    const def: Def =
      kind === 'value' ? { id, name, kind, expr: '1' }
      : kind === 'list' ? { id, name, kind, items: ['1', '2', '3'] }
      : { id, name, kind, params: ['t'], where: [], expr: 't^2' };
    (d.defs ??= []).push(def);
  });
  return id;
}

function editDef(id: string, fn: (def: Def) => void, coalesce?: string) {
  updateDoc((d) => {
    const def = d.defs?.find((x) => x.id === id);
    if (def) fn(def);
  }, coalesce);
}

/** Rename a definition and every use of it: other definitions, objects (fields and constructions) and the timeline. */
export function renameDef(id: string, newName: string) {
  newName = newName.trim();
  const doc = getState().doc;
  const def = doc.defs?.find((x) => x.id === id);
  if (!def || def.name === newName) return;
  if (!IDENT.test(newName)) return toast(`“${newName}” can't be a name: use letters, digits and _, starting with a letter`);
  if (doc.defs!.some((x) => x.name === newName) || doc.objects.some((o) => o.name === newName))
    return toast(`${newName} is taken`);
  const names = new Map([[def.name, newName]]);
  const rep = (s: string) => renameIdentifiers(s, names);
  updateDoc((d) => {
    for (const x of d.defs ?? []) {
      if (x.id === id) {
        x.name = newName;
        continue;
      }
      // a function's own inputs and where-names hide a definition of the same name: leave that function alone
      if ((x.params ?? []).includes(def.name) || (x.where ?? []).some((w) => w.name === def.name)) continue;
      if (x.expr) x.expr = rep(x.expr);
      if (x.items) x.items = x.items.map(rep);
      for (const w of x.where ?? []) w.expr = rep(w.expr);
    }
    for (const o of d.objects) renameRefs(o, names);
    renameInTimeline(d, names);
    for (const s of d.timeline) {
      const r = s.repeat;
      if (!r) continue;
      if (r.from) r.from = rep(r.from);
      if (r.to) r.to = rep(r.to);
      if (r.each) r.each = rep(r.each);
    }
  });
}

/** What the check found: the error, or what the definition is. */
function Info({ def, info }: { def: Def; info?: DefInfo }) {
  if (!info) return null;
  if (info.error) return <div className="err-box">{info.error}{info.hint ? <> {info.hint}</> : null}</div>;
  if (info.value !== undefined) return <p className="muted small">= {fmt(info.value)}</p>;
  if (info.length !== undefined)
    return <p className="muted small">{info.length} {info.length === 1 ? 'item' : 'items'}{info.items?.length ? `: ${info.items.slice(0, 4).map(fmt).join(', ')}${info.length > 4 ? ', …' : ''}` : ''}. Use one as <code>{def.name}[1]</code> (counting from 1), the count as <code>len({def.name})</code>.</p>;
  if (info.sample !== undefined) return <p className="muted small">{def.name}({(def.params ?? []).map(() => fmt(info.at ?? 1)).join(', ')}) = {fmt(info.sample)}</p>;
  return null;
}

function DefRow({ def, info }: { def: Def; info?: DefInfo }) {
  const key = `def:${def.id}`;
  return (
    <div className="def-row" data-def={def.name}>
      <div className="row">
        <Field className="mono def-name" value={def.name} onChange={() => {}} onBlur={(v) => renameDef(def.id, v)} ariaLabel={`Name of ${def.name}`} />
        {def.kind === 'function' && (
          <>
            <span className="mono">(</span>
            <Field className="mono def-params" value={(def.params ?? []).join(', ')} placeholder="t" ariaLabel={`Inputs of ${def.name}`}
              onChange={(v) => editDef(def.id, (x) => void (x.params = v.split(',').map((p) => p.trim()).filter(Boolean)), key + ':p')} />
            <span className="mono">)</span>
          </>
        )}
        <span className="mono">=</span>
        <span className="spacer" />
        <button className="x-btn" title={`Delete ${def.name}`} aria-label={`Delete ${def.name}`}
          onClick={() => updateDoc((d) => void (d.defs = (d.defs ?? []).filter((x) => x.id !== def.id)))}>×</button>
      </div>
      {def.kind === 'list' ? (
        <Field multiline className="mono" value={(def.items ?? []).join(', ')} ariaLabel={`Items of ${def.name}`} placeholder="14.1347, 21.022, 25.0109"
          onChange={(v) => editDef(def.id, (x) => void (x.items = splitTop(v.replace(/\n/g, ',')).map((i) => i.trim()).filter(Boolean)), key)} />
      ) : (
        <>
          {def.kind === 'function' && (def.where ?? []).map((w, i) => (
            <div key={i} className="row def-where">
              <span className="muted small">where</span>
              <Field className="mono def-name" value={w.name} ariaLabel={`Where name ${i + 1} of ${def.name}`}
                onChange={(v) => editDef(def.id, (x) => void (x.where![i].name = v.trim()), `${key}:w${i}n`)} />
              <span className="mono">=</span>
              <Field className="mono" value={w.expr} ariaLabel={`Where ${w.name || i + 1} of ${def.name}`}
                onChange={(v) => editDef(def.id, (x) => void (x.where![i].expr = v), `${key}:w${i}`)} />
              <button className="x-btn" title="Remove" aria-label={`Remove where ${w.name}`} onClick={() => editDef(def.id, (x) => void x.where!.splice(i, 1))}>×</button>
            </div>
          ))}
          <Field className="mono" value={def.expr ?? ''} ariaLabel={`Expression of ${def.name}`}
            placeholder={def.kind === 'function' ? 'sum(k, 1, n, cos(t ln(k))/sqrt(k))' : '2 pi'}
            onChange={(v) => editDef(def.id, (x) => void (x.expr = v), key)} />
          {def.kind === 'function' && (
            <button className="ghost small" title="A name worked out first, usable in what follows"
              onClick={() => editDef(def.id, (x) => void (x.where ??= []).push({ name: freeName(getState().doc, 'w'), expr: '1' }))}>+ where</button>
          )}
        </>
      )}
      <Info def={def} info={info} />
    </div>
  );
}

/** Scene › Definitions. */
export function DefinitionsPanel() {
  const defs = useStore((s) => s.doc.defs);
  const [info, setInfo] = useState<Record<string, DefInfo>>({});
  useEffect(() => {
    if (!defs?.length) return setInfo({});
    let live = true;
    const t = setTimeout(() => {
      api.checkDefs(defs).then((r) => live && setInfo(r.defs)).catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [defs]);
  return (
    <section className="defs-panel">
      <h4>Definitions</h4>
      {!defs?.length && (
        <p className="muted small">
          Named values, lists and functions, written in math: <code>2 pi</code>, <code>sum(k, 1, n, 1/k^2)</code>,{' '}
          <code>if(t &lt; 0, 0, sqrt(t))</code>. Graphs, points and every math field can use them by name.
        </p>
      )}
      {(defs ?? []).map((d) => <DefRow key={d.id} def={d} info={info[d.id]} />)}
      <div className="row">
        <button className="ghost small" onClick={() => addDef('value')}>+ value</button>
        <button className="ghost small" onClick={() => addDef('list')}>+ list</button>
        <button className="ghost small" onClick={() => addDef('function')}>+ function</button>
      </div>
    </section>
  );
}
