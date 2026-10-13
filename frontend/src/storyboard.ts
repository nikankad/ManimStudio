// Beats partition construct() statements. Manim remains the only scheduler.
import { objectDeps } from './construct';
import { compounds, namesUsed, walk, type Layout } from './timeline';
import type { Anim, Beat, SceneDoc, Step } from './types';

export const blankBeat = (): Beat => ({ id: 'beat-' + Math.random().toString(36).slice(2, 10), title: 'New explanation', steps: [], script: '', cues: [] });
export const flowName = (a: Anim) => ({ AnimationGroup: 'Together', Succession: 'Then', LaggedStart: 'Stagger' }[a.cls] ?? a.cls);
export function actionName(a: Anim): string {
  if (a.anims) return flowName(a);
  if (a.cls === 'expr') return 'Python animation';
  if (a.cls === 'animate') {
    const method = a.chain?.match(/^\.(\w+)/)?.[1];
    return `${{ set_value: 'Change parameter', move_to: 'Move', shift: 'Move', scale: 'Scale', rotate: 'Rotate points', set_color: 'Change color' }[method ?? ''] ?? 'Change'} ${a.target}`;
  }
  return `${{ Create: 'Draw', Write: 'Write', FadeIn: 'Reveal', FadeOut: 'Fade', Rotate: 'Rotate', MoveAlongPath: 'Follow path', Transform: 'Morph', TransformTerms: 'Move terms', ReplacementTransform: 'Replace', Indicate: 'Emphasize' }[a.cls] ?? a.cls} ${a.target}`;
}
export function stepName(s: Step): string {
  if (s.kind === 'play') return (s.anims ?? []).map(actionName).join(' + ') || 'Animate';
  if (s.kind === 'wait') return 'Hold for explanation';
  if (s.kind === 'block') return s.repeat ? `Repeat with ${s.repeat.var}` : s.head ?? 'Python block';
  if (s.kind === 'end') return 'End block';
  if (s.kind === 'code') return s.label ?? 'Python';
  return s.kind === 'call' ? `Scene: ${s.method}` : `${s.kind} ${(s.targets ?? [s.target ?? '']).join(', ')}`;
}
export function statementUnits(doc: SceneDoc): Step[][] {
  const byStart = new Map([...compounds(doc.timeline).values()].map((b) => [b.from, b.to]));
  const out: Step[][] = [];
  for (let i = 0; i < doc.timeline.length; i++) {
    const end = byStart.get(i) ?? i;
    out.push(doc.timeline.slice(i, end + 1)); i = end;
  }
  return out;
}
/** Repair membership after source edits: every statement once, in order, keeping whole blocks. */
export function beatsFor(doc: SceneDoc): Beat[] {
  const stored = doc.storyboard?.beats ?? [];
  const owner = new Map(stored.flatMap((b) => b.steps.map((s) => [s, b] as const)));
  const out: Beat[] = [], used = new Set<string>();
  for (const unit of statementUnits(doc)) {
    const own = unit.map((s) => owner.get(s.id)).find(Boolean);
    let last = out.at(-1);
    const newPlay = ['play', 'block'].includes(unit[0].kind) || unit[0].kind === 'call' && unit[0].method === 'next_section';
    if (!last || own && own.id !== last.id || !own && !stored.length && newPlay && last.steps.some((x) => doc.timeline.find((s) => s.id === x)?.kind === 'play')) {
      const source = own ?? blankBeat();
      last = { ...source, id: used.has(source.id) ? `split-${unit[0].id}` : source.id, steps: [], cues: [...source.cues] };
      if (!own) { last.id = `beat-${unit[0].id}`; last.title = stepName(unit.find((s) => s.kind === 'play') ?? unit[0]); }
      used.add(last.id); out.push(last);
    }
    last.steps.push(...unit.map((s) => s.id));
  }
  for (let i = 0; i < stored.length; i++) if (!stored[i].steps.some((id) => doc.timeline.some((s) => s.id === id))) {
    const next = stored.slice(i + 1).find((b) => out.some((x) => x.id === b.id));
    out.splice(next ? out.findIndex((b) => b.id === next.id) : out.length, 0, { ...stored[i], steps: [], cues: [] });
  }
  if (!out.length) out.push({ ...blankBeat(), id: 'beat-start', title: 'Build your first explanation' });
  return out.map((b) => ({ ...b, cues: b.cues.filter((c) => b.steps.includes(c.step)) }));
}
export function beatSpan(beat: Beat, beats: Beat[], lay: Layout) {
  const spans = beat.steps.map((s) => lay.steps.get(s)).filter((s) => !!s);
  const before = beats.slice(0, beats.findIndex((b) => b.id === beat.id)).flatMap((b) => b.steps).map((s) => lay.steps.get(s)?.end ?? 0);
  const start = spans.length ? Math.min(...spans.map((s) => s.start)) : Math.max(0, ...before);
  return { start, end: spans.length ? Math.max(...spans.map((s) => s.end)) : start, estimated: spans.some((s) => s.estimated) };
}
export function beatBoundary(doc: SceneDoc, beat: Beat, edge: 'start' | 'end') {
  const enabled = statementUnits(doc).filter((u) => !u[0].disabled);
  const units = enabled.filter((u) => beat.steps.includes(u[0].id));
  const step = edge === 'start' ? units[0]?.[0] : units.at(-1)?.at(-1);
  if (step) return { id: step.id, edge };
  // Planning cards hold the preceding result, or the state before the first active statement.
  const beats = beatsFor(doc), index = beats.findIndex((b) => b.id === beat.id);
  const before = new Set(beats.slice(0, Math.max(0, index)).flatMap((b) => b.steps));
  const previous = enabled.filter((u) => before.has(u[0].id)).at(-1)?.at(-1);
  return previous ? { id: previous.id, edge: 'end' as const } : enabled[0] ? { id: enabled[0][0].id, edge: 'start' as const } : undefined;
}
export function appendToBeat(doc: SceneDoc, beatId: string, steps: Step[]) {
  const beats = beatsFor(doc), beat = beats.find((b) => b.id === beatId) ?? beats.at(-1)!;
  const next = beats.slice(beats.indexOf(beat) + 1).flatMap((b) => b.steps)[0];
  doc.timeline.splice(next ? doc.timeline.findIndex((s) => s.id === next) : doc.timeline.length, 0, ...steps);
  beat.steps.push(...steps.map((s) => s.id)); doc.storyboard = { beats };
}
export function splitBeat(doc: SceneDoc, beatId: string, atStep: string) {
  const beats = beatsFor(doc), beat = beats.find((b) => b.id === beatId);
  const unit = statementUnits(doc).find((u) => u[0].id === atStep), at = beat?.steps.indexOf(atStep) ?? -1;
  if (!beat || !unit || at <= 0) return false;
  const next = { ...blankBeat(), title: stepName(unit[0]), steps: beat.steps.splice(at) };
  next.cues = beat.cues.filter((c) => next.steps.includes(c.step)); beat.cues = beat.cues.filter((c) => beat.steps.includes(c.step));
  beats.splice(beats.indexOf(beat) + 1, 0, next); doc.storyboard = { beats }; return true;
}
function references(doc: SceneDoc, b: Beat) {
  const names = new Set(doc.timeline.filter((s) => b.steps.includes(s.id)).flatMap((s) => [...namesUsed(s)]));
  const ids = new Set(doc.objects.filter((o) => names.has(o.name)).map((o) => o.id));
  for (const s of doc.timeline.filter((s) => b.steps.includes(s.id))) for (const a of walk(s.anims)) if (a.terms) ids.add(a.terms.to);
  for (let changed = true; changed;) {
    changed = false;
    for (const o of doc.objects) if (ids.has(o.id)) {
      const names = namesUsed({ id: o.id, kind: 'code', code: [o.ctor, o.chain, ...Object.values(o.args)].join(' ') });
      const deps = [...objectDeps(o, doc), ...doc.objects.filter((x) => x.id !== o.id && names.has(x.name)).map((x) => x.id)];
      for (const dep of deps) if (!ids.has(dep)) { ids.add(dep); changed = true; }
    }
  }
  return ids;
}
function opaque(doc: SceneDoc, b: Beat) {
  return doc.timeline.some((s) => b.steps.includes(s.id) && (!['play', 'wait', 'add', 'remove', 'couple', 'uncouple'].includes(s.kind) ||
    [...walk(s.anims)].some((a) => a.cls === 'expr' || /^self\./.test(a.target) || !a.anims && !doc.objects.some((o) => o.name === a.target))));
}
/** Only move independent beats; arbitrary Python never gets an inferred dependency order. */
export function moveBeat(doc: SceneDoc, beatId: string, delta: number): string | null {
  const beats = beatsFor(doc), index = beats.findIndex((b) => b.id === beatId), to = index + delta;
  if (index < 0 || to < 0 || to >= beats.length) return 'Already at the edge of the storyboard.';
  const beat = beats[index], crossed = beats.slice(Math.min(index, to), Math.max(index, to) + 1).filter((b) => b !== beat);
  if (beat.steps.length && crossed.some((b) => b.steps.length && (opaque(doc, b) || opaque(doc, beat) || doc.scene.members?.trim() || doc.scene.members_after?.trim() || doc.objects.some((o) => /add_updater|always_redraw/.test(o.chain + o.ctor))))) return 'Python or scene control owns this order. Regroup these actions or edit their code.';
  const refs = references(doc, beat), shared = crossed.flatMap((b) => [...references(doc, b)]).find((s) => refs.has(s));
  if (shared) return `These beats both use ${doc.objects.find((o) => o.id === shared)?.name}. Their state depends on this order.`;
  const ordered = [...beats]; ordered.splice(index, 1); ordered.splice(to, 0, beat);
  const ids = ordered.flatMap((b) => b.steps);
  for (const o of doc.objects) if (o.after && doc.timeline.some((s) => namesUsed(s).has(o.name) && ids.indexOf(s.id) <= ids.indexOf(o.after!))) return `${o.name} must be created before this beat. Keep its setup first.`;
  const byId = new Map(doc.timeline.map((s) => [s.id, s]));
  doc.timeline = ids.map((s) => byId.get(s)!); doc.storyboard = { beats: ordered }; return null;
}
