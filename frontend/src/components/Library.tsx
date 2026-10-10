import { useMemo, useState } from 'react';
import { addAnimation, addObject, getState, setState, useStore } from '../store';
import type { CatalogEntry } from '../types';

export const DND_TYPE = 'application/x-mathengine';
export type DragPayload = { kind: 'mobject' | 'animation'; name: string };

function group(entries: CatalogEntry[], query: string): [string, CatalogEntry[]][] {
  const q = query.trim().toLowerCase();
  const hits = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
  if (q) return [['Results', hits]];
  const featured = hits.filter((e) => e.featured >= 0).sort((a, b) => a.featured - b.featured);
  const byCat = new Map<string, CatalogEntry[]>();
  for (const e of hits) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category)!.push(e);
  }
  return [['Common', featured], ...[...byCat.entries()].sort(([a], [b]) => a.localeCompare(b))];
}

export function Library() {
  const catalog = useStore((s) => s.catalog);
  const [tab, setTab] = useState<'mobject' | 'animation' | 'outline'>('mobject');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ Common: true, Results: true });

  const groups = useMemo(() => {
    if (!catalog || tab === 'outline') return [];
    return group(tab === 'mobject' ? catalog.mobjects : catalog.animations, query);
  }, [catalog, tab, query]);

  const activate = (e: CatalogEntry) => {
    const s = getState();
    if (e.kind === 'mobject') {
      const sel = s.selection?.kind === 'object' ? s.doc.objects.find((o) => o.id === s.selection!.id) : undefined;
      addObject(e.name, [0, 0], sel?.name);
    } else {
      const sel = s.selection?.kind === 'object' ? s.doc.objects.find((o) => o.id === s.selection!.id) : undefined;
      const target = sel?.name ?? s.doc.objects[s.doc.objects.length - 1]?.name ?? '';
      addAnimation(e.name, target);
    }
  };

  return (
    <aside className="panel library">
      <div className="tabs">
        <button className={tab === 'mobject' ? 'on' : ''} onClick={() => setTab('mobject')}>Objects</button>
        <button className={tab === 'animation' ? 'on' : ''} onClick={() => setTab('animation')}>Animations</button>
        <button className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>Scene</button>
      </div>
      {tab === 'outline' ? (
        <Outline />
      ) : (
        <>
          <input className="search" placeholder={`Search ${tab === 'mobject' ? catalog?.mobjects.length ?? '' : catalog?.animations.length ?? ''} manim classes…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {!catalog && <div className="muted pad">Loading manim…</div>}
          <div className="scroll">
            {tab === 'animation' && !query && (
              <div className="hint pad">Drag onto an object in the canvas, or onto a timeline block to play in parallel.</div>
            )}
            {tab === 'animation' && (
              <LibItem entry={{ name: 'animate', kind: 'animation', category: '', doc: 'mobject.animate.<method>(…) — animate any method call (shift, scale, set_color…)', bases: [], vector: true, starter: {}, featured: 0 }} onActivate={activate} label=".animate" />
            )}
            {groups.map(([cat, items]) =>
              items.length ? (
                <div key={cat} className="group">
                  <div className="group-head" onClick={() => setOpen((o) => ({ ...o, [cat]: !o[cat] }))}>
                    <span>{open[cat] || query ? '▾' : '▸'}</span> {cat} <span className="muted">{items.length}</span>
                  </div>
                  {(open[cat] || query) && (
                    <div className="grid">
                      {items.map((e) => <LibItem key={e.name} entry={e} onActivate={activate} />)}
                    </div>
                  )}
                </div>
              ) : null,
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function LibItem({ entry, onActivate, label }: { entry: CatalogEntry; onActivate: (e: CatalogEntry) => void; label?: string }) {
  return (
    <div
      className={`lib-item ${entry.kind}`}
      draggable
      title={entry.doc || entry.name}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(DND_TYPE, JSON.stringify({ kind: entry.kind, name: entry.name } satisfies DragPayload));
        ev.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => onActivate(entry)}
    >
      {label ?? entry.name}
    </div>
  );
}

function Outline() {
  const objects = useStore((s) => s.doc.objects);
  const selection = useStore((s) => s.selection);
  const frame = useStore((s) => s.frame);
  const error = frame?.error;
  return (
    <div className="scroll outline">
      {objects.length === 0 && <div className="muted pad">Drag objects from the library onto the canvas.</div>}
      {objects.map((o) => {
        const info = frame?.objects.find((i) => i.id === o.id);
        return (
          <div
            key={o.id}
            className={`outline-row ${selection?.kind === 'object' && selection.id === o.id ? 'sel' : ''} ${error?.id === o.id ? 'err' : ''}`}
            onClick={() => setState({ selection: { kind: 'object', id: o.id } })}
          >
            <span className={`dot ${info?.visible ? 'on' : ''}`} title={info?.visible ? 'on screen now' : 'not on screen now'} />
            <span className="mono">{o.name}</span>
            <span className="muted">{o.ctor}</span>
          </div>
        );
      })}
    </div>
  );
}
