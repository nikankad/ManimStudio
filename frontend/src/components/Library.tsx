import { useMemo, useState } from 'react';
import { api } from '../api';
import { dependentsOf, describeLink, linkSources, linkState, type LinkState } from '../construct';
import {
  addAnimation, addObject, addStep, newObjectPos, coupleObjects, detachObjects, docLayout, getState, sceneCalls, selectClips, selectedObjectIds, selectObjects, setState, timecode, toast, toggleObjectSelection,
  uncoupleObjects, updateDoc, useStore,
} from '../store';
import { syncInstances } from '../templates';
import type { Template } from '../types';
import type { CatalogEntry } from '../types';

export const DND_TYPE = 'application/x-mathengine';
export type DragPayload = { kind: 'mobject' | 'animation'; name: string };

function group(entries: CatalogEntry[], query: string): [string, CatalogEntry[]][] {
  const q = query.trim().toLowerCase();
  const hits = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
  if (q) {
    // Exact name first, then names starting with the query, then common classes, then other matches.
    const rank = (e: CatalogEntry) => {
      const n = e.name.toLowerCase();
      return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? (e.featured >= 0 ? 2 : 3) : 4;
    };
    return [['Results', [...hits].sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name))]];
  }
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
      addObject(e.name, newObjectPos(e.name), sel?.name);
    } else {
      const target = sel?.name ?? s.doc.objects[s.doc.objects.length - 1]?.name ?? '';
      if (!target) return toast('Add an object first, then add animations');
      addAnimation(e.name, target);
      if (!sel) toast(`${e.name === 'animate' ? '.animate' : e.name} animates ${target}, the newest object. Select an object first to target it, or change it in Effect Controls`);
    }
  };

  return (
    <aside className="panel library" data-tour="library">
      <div className="tabs">
        <button className={tab === 'mobject' ? 'on' : ''} onClick={() => setTab('mobject')}>Objects</button>
        <button className={tab === 'animation' ? 'on' : ''} onClick={() => setTab('animation')}>Effects</button>
        <button data-tour="build" className={tab === 'constructions' ? 'on' : ''} onClick={() => setTab('constructions')} title="Reusable constructions">Build</button>
        <button className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>Scene</button>
      </div>
      {tab === 'outline' ? (
        <Outline />
      ) : tab === 'constructions' ? (
        <Constructions />
      ) : (
        <>
          <input className="search" placeholder={`Search ${tab === 'mobject' ? catalog?.mobjects.length ?? '' : catalog?.animations.length ?? ''} manim classes…`} value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              } else if (e.key === 'Enter') {
                // Add the top result: type a name, press Enter.
                const first = groups.flatMap(([, items]) => items)[0];
                if (!first) return;
                activate(first);
                setQuery('');
                e.currentTarget.blur();
              }
            }}
          />
          {!catalog && <div className="muted pad">Loading manim…</div>}
          <div className="scroll">
            {tab === 'animation' && !query && (
              <div className="hint pad">Drag onto an object on the canvas (plays at the playhead) or onto a timeline track: dropped on a self.play it plays with it, dropped in a pause it starts there. It targets the selected object.</div>
            )}
            {tab === 'animation' && (
              <LibItem entry={{ name: 'animate', kind: 'animation', category: '', doc: 'mobject.animate.<method>(…) — animate any method call (shift, scale, set_color…)', bases: [], vector: true, starter: {}, featured: 0 }} onActivate={activate} label=".animate" />
            )}
            {tab === 'animation' && catalog && (!query || sceneCalls().some((m) => m.includes(query.toLowerCase()))) && (
              <div className="group">
                <div className="group-head" onClick={() => setOpen((o) => ({ ...o, __scene: !o.__scene }))} title="Other methods of the scene: a statement at the playhead">
                  <span>{open.__scene || query ? '▾' : '▸'}</span> Scene <span className="muted">{sceneCalls().length}</span>
                </div>
                {(open.__scene || query) && (
                  <div className="grid">
                    {sceneCalls().filter((m) => !query || m.includes(query.toLowerCase())).map((m) => (
                      <button key={m} className="lib-item mono" title={`self.${m}(…) at the playhead`} onClick={() => addStep('call', { method: m })}>{m}</button>
                    ))}
                  </div>
                )}
              </div>
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

/** Give the keyboard back to the editor (Space plays, Delete deletes) once something is taken from the library. */
function leaveSearch() {
  const el = document.activeElement as HTMLElement | null;
  if (el?.classList.contains('search')) el.blur();
}

function LibItem({ entry, onActivate, label }: { entry: CatalogEntry; onActivate: (e: CatalogEntry) => void; label?: string }) {
  return (
    <div
      className={`lib-item ${entry.kind}`}
      draggable
      tabIndex={0}
      role="button"
      title={entry.doc || entry.name}
      onKeyDown={(ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return; // add it, as a double-click does
        ev.preventDefault();
        ev.stopPropagation();
        leaveSearch();
        onActivate(entry);
      }}
      onDragStart={(ev) => {
        leaveSearch();
        ev.dataTransfer.setData(DND_TYPE, JSON.stringify({ kind: entry.kind, name: entry.name } satisfies DragPayload));
        ev.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={(ev) => ev.currentTarget.blur()} // keyboard focus only: after a mouse click Space plays again
      onDoubleClick={() => {
        leaveSearch();
        onActivate(entry);
      }}
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
  const [view, setView] = useState<'objects' | 'relationships'>('objects');
  const count = objects.filter((o) => o.link).length;
  const toggle = (
    <div className="seg outline-view">
      <button className={view === 'objects' ? 'on' : ''} onClick={() => setView('objects')}>Objects</button>
      <button className={view === 'relationships' ? 'on' : ''} onClick={() => setView('relationships')} title="Every relationship in the scene: what is coupled to what, and whether it is in effect">Relationships{count ? ` (${count})` : ''}</button>
    </div>
  );
  if (view === 'relationships') return <div className="outline-wrap">{toggle}<Relationships /></div>;
  return (
    <div className="outline-wrap">
    {toggle}
    <div className="scroll outline">
      {objects.length === 0 && <div className="muted pad">Drag objects from the library onto the canvas.</div>}
      {objects.map((o) => {
        const info = frame?.objects.find((i) => i.id === o.id);
        return (
          <div
            key={o.id}
            className={`outline-row ${selectedObjectIds(selection).includes(o.id) ? 'sel' : ''} ${error?.id === o.id ? 'err' : ''}`}
            tabIndex={0}
            role="button"
            aria-pressed={selectedObjectIds(selection).includes(o.id)}
            onClick={(e) => {
              if (e.shiftKey) toggleObjectSelection(o.id);
              else selectObjects([o.id]);
              e.currentTarget.blur(); // keyboard focus only: after a mouse click Space plays again
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return; // select it
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) toggleObjectSelection(o.id);
              else selectObjects([o.id]);
            }}
          >
            <span className={`dot ${info?.visible ? 'on' : ''}`} title={info?.visible ? 'on screen now' : 'not on screen now'} />
            <span className="mono">{o.name}</span>
            <span className={`muted ${o.link?.off ? 'paused' : ''}`} title={o.link ? (o.link.off ? 'Relationship paused (uncoupled)' : 'Coupled') : undefined}>{o.link ? `⛓ ${o.link.kind}${o.link.off ? ' · paused' : ''}` : o.ctor}</span>
          </div>
        );
      })}
    </div>
    </div>
  );
}

const STATE_LABEL: Record<LinkState, string> = { coupled: 'coupled', uncoupled: 'paused', frozen: 'frozen' };

/** Overview of every relationship: state, sources, timeline switches; couple, uncouple and forget from here. */
function Relationships() {
  const doc = useStore((s) => s.doc);
  const lay = useStore((s) => docLayout(s.doc, s.timeline));
  const selection = useStore((s) => s.selection);
  const diagnostics = useStore((s) => (s.timeline ?? s.frame)?.diagnostics);
  const [filter, setFilter] = useState<'all' | LinkState>('all');
  const linked = doc.objects.filter((o) => o.link);
  const shown = linked.filter((o) => filter === 'all' || linkState(o) === filter);
  const name = (id: string) => doc.objects.find((o) => o.id === id)?.name ?? '(deleted)';
  const sel = new Set(selectedObjectIds(selection));
  if (!linked.length)
    return <div className="muted pad small">No relationships yet. Select two objects and pick one under Couple (Effect Controls or right-click), or build new objects from existing ones under Connect.</div>;
  const coupled = shown.filter((o) => linkState(o) === 'coupled').map((o) => o.id);
  const paused = shown.filter((o) => linkState(o) !== 'coupled').map((o) => o.id);
  return (
    <div className="scroll relationships">
      <div className="rel-bar">
        <select className="field" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All ({linked.length})</option>
          <option value="coupled">Coupled</option>
          <option value="uncoupled">Paused</option>
          <option value="frozen">Frozen</option>
        </select>
        <button className="ghost small" disabled={!coupled.length} title="Pause every listed relationship" onClick={() => uncoupleObjects(coupled)}>Uncouple all</button>
        <button className="ghost small" disabled={!paused.length} title="Restore every listed relationship" onClick={() => coupleObjects(paused)}>Couple all</button>
      </div>
      {shown.map((o) => {
        const state = linkState(o)!;
        const sources = linkSources(o.link);
        const users = dependentsOf(doc, [o.id]);
        const switches = doc.timeline.filter((c) => (c.kind === 'couple' || c.kind === 'uncouple') && c.targets?.includes(o.name));
        const problem = diagnostics?.find((d) => d.id === o.id && d.level === 'error');
        return (
          <div key={o.id} className={`rel-row ${state} ${sel.has(o.id) ? 'sel' : ''} ${problem ? 'err' : ''}`} title={problem?.message}>
            <div className="rel-head">
              <button className={`rel-switch ${state}`} title={state === 'coupled' ? 'Coupled: click to uncouple (pause) it' : 'Paused: click to couple it again'}
                onClick={() => (state === 'coupled' ? uncoupleObjects([o.id]) : coupleObjects([o.id]))}>{STATE_LABEL[state]}</button>
              <button className="rel-name mono" title="Select it" onClick={(e) => (e.shiftKey ? toggleObjectSelection(o.id) : selectObjects([o.id]))}>{o.name}</button>
              <span className="spacer" />
              <button className="x-btn" title="Select it with what it is built from" onClick={() => selectObjects([o.id, ...sources.filter((id) => doc.objects.some((x) => x.id === id))])}>⇢</button>
              <button className="x-btn" title="Forget the relationship (it becomes an independent object where it is)" onClick={() => detachObjects([o.id])}>×</button>
            </div>
            <div className="rel-desc muted small">{describeLink(o, doc)}</div>
            {(sources.length > 0 || users.length > 0 || switches.length > 0) && (
              <div className="chips">
                {sources.map((id) => <button key={id} className="chip" title="Built from (select)" onClick={() => selectObjects([id])}>← {name(id)}</button>)}
                {users.map((u) => <button key={u.id} className="chip" title="Built from this (select)" onClick={() => selectObjects([u.id])}>→ {u.name}</button>)}
                {switches.map((c) => <button key={c.id} className={`chip switch-chip ${c.kind}`} title="Select it on the timeline" onClick={() => selectClips([c.id])}>{c.kind === 'couple' ? '⛓' : '⊘'} {timecode(lay.steps.get(c.id)?.start ?? 0)}</button>)}
              </div>
            )}
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
