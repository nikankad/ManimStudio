import { useMemo, useState } from 'react';
import { api } from '../api';
import { addAnimation, addObject, getState, selectedObjectIds, selectObjects, setState, toast, toggleObjectSelection, updateDoc, useStore } from '../store';
import { syncInstances } from '../templates';
import type { Template } from '../types';
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
  const [tab, setTab] = useState<'mobject' | 'animation' | 'outline' | 'constructions'>('mobject');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ Common: true, Results: true });

  const groups = useMemo(() => {
    if (!catalog || tab === 'outline' || tab === 'constructions') return [];
    return group(tab === 'mobject' ? catalog.mobjects : catalog.animations, query);
  }, [catalog, tab, query]);

  const activate = (e: CatalogEntry) => {
    const s = getState();
    const selId = s.selection?.kind === 'object' ? s.selection.id : null;
    const sel = s.doc.objects.find((o) => o.id === selId);
    if (e.kind === 'mobject') {
      addObject(e.name, [0, 0], sel?.name);
    } else {
      const target = sel?.name ?? s.doc.objects[s.doc.objects.length - 1]?.name ?? '';
      addAnimation(e.name, target);
    }
  };

  return (
    <aside className="panel library">
      <div className="tabs">
        <button className={tab === 'mobject' ? 'on' : ''} onClick={() => setTab('mobject')}>Objects</button>
        <button className={tab === 'animation' ? 'on' : ''} onClick={() => setTab('animation')}>Effects</button>
        <button className={tab === 'constructions' ? 'on' : ''} onClick={() => setTab('constructions')} title="Reusable constructions">Build</button>
        <button className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>Scene</button>
      </div>
      {tab === 'outline' ? (
        <Outline />
      ) : tab === 'constructions' ? (
        <Constructions />
      ) : (
        <>
          <input className="search" placeholder={`Search ${tab === 'mobject' ? catalog?.mobjects.length ?? '' : catalog?.animations.length ?? ''} manim classes…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          {!catalog && <div className="muted pad">Loading manim…</div>}
          <div className="scroll">
            {tab === 'animation' && !query && (
              <div className="hint pad">Drag onto an object on the canvas (plays at the playhead) or onto any timeline track at any time. It targets the selected object.</div>
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
            className={`outline-row ${selectedObjectIds(selection).includes(o.id) ? 'sel' : ''} ${error?.id === o.id ? 'err' : ''}`}
            onClick={(e) => (e.shiftKey ? toggleObjectSelection(o.id) : selectObjects([o.id]))}
          >
            <span className={`dot ${info?.visible ? 'on' : ''}`} title={info?.visible ? 'on screen now' : 'not on screen now'} />
            <span className="mono">{o.name}</span>
            <span className="muted">{o.link ? `⛓ ${o.link.kind}` : o.ctor}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Reusable constructions: starters, this project's, and the user's library. */
function Constructions() {
  const starters = useStore((s) => s.starters);
  const library = useStore((s) => s.library);
  const project = useStore((s) => s.doc.constructions) ?? [];
  const sel = selectedObjectIds(useStore((s) => s.selection));
  const removeProject = (t: Template) => updateDoc((d) => void (d.constructions = (d.constructions ?? []).filter((x) => x.id !== t.id)));
  const removeLibrary = async (t: Template) => {
    const next = library.filter((x) => x.id !== t.id);
    await api.saveLibrary(next);
    setState({ library: next });
  };
  const row = (t: Template, remove?: () => void) => (
    <div key={t.id} className="construction-row" title={t.description}>
      <button className="construction-name" onClick={() => setState({ panel: 'insert', panelData: t })}>{t.name}</button>
      <span className="muted small">{t.objects.length} objects</span>
      {!t.builtin && <button className="x-btn" title="Update linked instances of this template" onClick={() => syncInstances(t.id)}>⟳</button>}
      {remove && <button className="x-btn" title="Remove" onClick={() => { if (confirm(`Remove "${t.name}"?`)) remove(); }}>×</button>}
    </div>
  );
  return (
    <div className="scroll pad constructions">
      <button disabled={!sel.length} onClick={() => setState({ panel: 'save-construction', panelData: sel })} title="Save the selected objects (and what they are built from)">Save selection as construction…</button>
      <h4>Starters</h4>
      {starters.length ? starters.map((t) => row(t)) : <span className="muted small">Loading…</span>}
      <h4>This project</h4>
      {project.length ? project.map((t) => row(t, () => removeProject(t))) : <span className="muted small">Select objects and save them to reuse them here.</span>}
      <h4>My library</h4>
      {library.length ? library.map((t) => row(t, () => void removeLibrary(t).catch((e) => toast(String(e))))) : <span className="muted small">Constructions saved to your library are available in every project.</span>}
    </div>
  );
}
