// Reusable constructions: save a selection as a template, insert instances, keep linked instances in sync.
//
// An inserted instance always gets new object ids and unique names, so instances never share
// objects. It is either an independent copy (no ties to the template afterwards) or linked:
// each of its objects records `instance` = { template, instance, local, linked, inputs }, and
// "Update instances" regenerates linked instances from the current template, keeping their ids
// and names (so their animations on the timeline stay attached) and their own input values.

import { api } from './api';
import { linkSources, objectDeps, remapLink, renameRefs, sortByDependencies, standsAlone } from './construct';
import { bakeTransform, freeShape, shapeCenter, writeShape } from './geometry';
import { pyQuote, renameIdentifiers } from './pyparse';
import { frameSnap, getState, placeStepAt, selectObjects, setState, toast, uid, uniqueName, updateDoc } from './store';
import { cloneStep, forgetObjects, layout, stepEstimate, targetsOf, walk } from './timeline';
import type { Pt, SceneDoc, SceneObject, Step, Template, TemplateInput } from './types';

/** Every template available: the project's own, the user's library, and the starters. */
export function allTemplates(): Template[] {
  const s = getState();
  return [...(s.doc.constructions ?? []), ...s.library, ...s.starters];
}

export async function loadTemplates() {
  try {
    const r = await api.constructions();
    setState({ starters: r.starters, library: r.library });
  } catch (e) {
    toast(String(e));
  }
}

export const defaultInputs = (t: Template) => Object.fromEntries(t.inputs.map((i) => [i.id, i.default]));

function applyInputs(t: Template, values: Record<string, string>, byLocal: Map<string, SceneObject>): Set<string> {
  const hidden = new Set<string>();
  for (const inp of t.inputs) {
    const v = values[inp.id] ?? inp.default;
    for (const target of inp.targets) {
      const o = byLocal.get(target.object);
      if (!o) continue;
      if (inp.kind === 'param') o.args['*'] = v;
      else if (inp.kind === 'color') o.args[target.key ?? 'color'] = v;
      else if (inp.kind === 'text') o.args['*'] = /^(MathTex|Tex)$/.test(o.ctor) ? `r"${v.replace(/"/g, '\\"')}"` : pyQuote(v);
      else if (inp.kind === 'visible' && v !== 'True') hidden.add(o.id);
    }
  }
  return hidden;
}

function offsetObject(o: SceneObject, offset: Pt) {
  if ((o.link && !standsAlone(o)) || (!offset[0] && !offset[1])) return;
  const shape = freeShape(o);
  const moved = shape && bakeTransform(shape, { move: offset }, shapeCenter(shape));
  if (moved) writeShape(o, moved);
  else if (o.pos) o.pos = [o.pos[0] + offset[0], o.pos[1] + offset[1]];
}

/** Build fresh objects for one instance. `keep` maps local ids to existing objects (re-sync of a linked instance). */
function build(d: SceneDoc, t: Template, values: Record<string, string>, offset: Pt, inst: string, linked: boolean, keep: Map<string, SceneObject> = new Map()) {
  const idMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  const objs: SceneObject[] = [];
  const byLocal = new Map<string, SceneObject>();
  const taken = new Set(d.objects.map((o) => o.name));
  for (const src of t.objects) {
    const prev = keep.get(src.id);
    const o: SceneObject = structuredClone(src);
    o.id = prev?.id ?? uid('o');
    o.name = prev?.name ?? uniqueName({ ...d, objects: [...taken].map((name) => ({ name }) as SceneObject) }, src.name);
    taken.add(o.name);
    o.instance = { template: t.id, instance: inst, local: src.id, linked, inputs: values, offset };
    idMap.set(src.id, o.id);
    nameMap.set(src.name, o.name);
    objs.push(o);
    byLocal.set(src.id, o);
  }
  for (const o of objs) {
    remapLink(o, idMap);
    renameRefs(o, nameMap);
    offsetObject(o, offset);
  }
  const hidden = applyInputs(t, values, byLocal);
  return { objs, nameMap, hidden };
}

/** Insert an instance of `t` at the playhead. */
export function insertTemplate(t: Template, values: Record<string, string>, linked: boolean, offset: Pt = [0, 0]) {
  const inst = uid('i');
  const newIds: string[] = [];
  let start = frameSnap(getState().time);
  let intro = 0;
  updateDoc((d) => {
    const { objs, nameMap, hidden } = build(d, t, values, offset, inst, linked);
    d.objects.push(...objs);
    sortByDependencies(d);
    newIds.push(...objs.map((o) => o.id));
    const hiddenNames = new Set(objs.filter((o) => hidden.has(o.id)).map((o) => o.name));
    const steps = (t.timeline ?? []).map((s) => instanceStep(s, nameMap, hiddenNames)).filter((s): s is Step => !!s);
    if (steps.length) start = placeStepAt(d, steps);
    // Show the construction once its intro has played (the first animation of a parameter comes after it).
    const first = steps.findIndex((s) => [...walk(s.anims)].some((a) => a.cls === 'animate' && a.chain?.includes('set_value')));
    intro = steps.slice(0, first < 0 ? steps.length : first).reduce((acc, s) => acc + stepEstimate(s), 0);
  });
  selectObjects(newIds);
  setState({ time: frameSnap(start + intro) });
  toast(`Inserted ${t.name}${linked ? ' (linked to its template)' : ''}`);
}

/** A template step for an instance: new ids, the instance's object names, hidden objects left out. */
function instanceStep(s: Step, nameMap: Map<string, string>, hidden: Set<string>): Step | null {
  const c = cloneStep(s);
  const rename = (n: string) => renameIdentifiers(n, nameMap);
  if (c.targets) {
    c.targets = c.targets.map((n) => nameMap.get(n) ?? n).filter((n) => !hidden.has(n));
    if (!c.targets.length) return null;
  }
  if (c.code) c.code = rename(c.code);
  if (c.anims) {
    const keep = (list: NonNullable<Step['anims']>): NonNullable<Step['anims']> => list.filter((a) => {
      a.target = a.target ? rename(a.target) : a.target;
      if (a.chain) a.chain = rename(a.chain);
      for (const k in a.args) a.args[k] = rename(a.args[k]);
      if (a.anims) a.anims = keep(a.anims);
      return !(a.target && targetsOf({ ...a, anims: undefined }).every((n) => hidden.has(n))) && !(a.anims && !a.anims.length);
    });
    c.anims = keep(c.anims);
    if (!c.anims.length) return null;
  }
  return c;
}

/** Selected objects plus everything they're built from (a construction must be self-contained). */
export function closure(doc: SceneDoc, ids: string[]): SceneObject[] {
  const keep = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const o of doc.objects) if (keep.has(o.id)) for (const dep of objectDeps(o, doc)) if (!keep.has(dep)) {
      keep.add(dep);
      grew = true;
    }
  }
  return doc.objects.filter((o) => keep.has(o.id));
}

/** Inputs worth offering for a set of objects: parameters, label texts, colors, visibility of labels. */
export function suggestInputs(objs: SceneObject[]): (TemplateInput & { use: boolean })[] {
  const out: (TemplateInput & { use: boolean })[] = [];
  for (const o of objs) {
    if (o.ctor === 'ValueTracker') out.push({ id: uid('in'), kind: 'param', label: o.name, default: o.args['*'] ?? '0', targets: [{ object: o.id }], use: true });
    const text = o.args['*']?.match(/^r?"([^"\\]*)"$/);
    if (text && /^(MathTex|Tex|Text)$/.test(o.ctor)) out.push({ id: uid('in'), kind: 'text', label: `${o.name} text`, default: text[1], targets: [{ object: o.id }], use: true });
    if (o.args.color) out.push({ id: uid('in'), kind: 'color', label: `${o.name} color`, default: o.args.color, targets: [{ object: o.id, key: 'color' }], use: false });
    if (o.link?.kind === 'attach' || o.link?.kind === 'measure') out.push({ id: uid('in'), kind: 'visible', label: `Show ${o.name}`, default: 'True', targets: [{ object: o.id }], use: false });
  }
  return out;
}

/** Make a template from objects (their ids become the template-local ids). */
export function makeTemplate(doc: SceneDoc, objs: SceneObject[], name: string, description: string, inputs: TemplateInput[]): Template {
  const names = new Set(objs.map((o) => o.name));
  const ids = new Set(objs.map((o) => o.id));
  // The statements about these objects, in order: their animations, and adding or switching them.
  const ours = (a: { target: string; anims?: unknown[] }) => a.anims !== undefined || (!!a.target && a.target.split(',').every((n) => names.has(n.trim())));
  const steps: Step[] = [];
  for (const s of doc.timeline) {
    if (s.disabled) continue;
    if (s.kind === 'play') {
      const anims = structuredClone(s.anims ?? []).filter((a) => ours(a) && targetsOf(a).every((n) => names.has(n)) && !a.disabled);
      if (anims.length) steps.push({ ...structuredClone(s), anims });
    } else if (s.targets?.length && s.targets.every((n) => names.has(n))) steps.push(structuredClone(s));
  }
  const outside = objs.flatMap((o) => linkSources(o.link)).filter((s) => !ids.has(s));
  if (outside.length) throw new Error('The construction refers to objects outside it');
  return {
    id: uid('tpl'),
    name,
    description,
    objects: objs.map((o) => {
      const c = structuredClone(o);
      delete c.instance;
      return c;
    }),
    timeline: steps,
    inputs,
  };
}

export async function saveTemplate(t: Template, where: 'project' | 'library') {
  if (where === 'project') {
    updateDoc((d) => void (d.constructions = [...(d.constructions ?? []), t]));
  } else {
    const library = [...getState().library, t];
    await api.saveLibrary(library);
    setState({ library });
  }
  toast(`Saved construction "${t.name}"`);
}

/** Objects of one instance. */
export const instanceObjects = (doc: SceneDoc, inst: string) => doc.objects.filter((o) => o.instance?.instance === inst);

/** Cut an instance loose from its template. */
export function detachInstance(inst: string) {
  updateDoc((d) => {
    for (const o of d.objects) if (o.instance?.instance === inst) delete o.instance;
  });
}

/** Replace a project template with the current state of one of its linked instances, then re-sync the others. */
export function updateTemplateFromInstance(inst: string) {
  const s = getState();
  const objs = instanceObjects(s.doc, inst);
  const tplId = objs[0]?.instance?.template;
  const tpl = (s.doc.constructions ?? []).find((t) => t.id === tplId);
  if (!tpl) return toast('Only templates saved in this project can be updated from an instance');
  const toLocal = new Map(objs.map((o) => [o.id, o.instance!.local]));
  const offset = objs[0].instance?.offset ?? [0, 0];
  const next: Template = {
    ...tpl,
    objects: objs.map((o) => {
      const c = structuredClone(o);
      c.id = o.instance!.local;
      delete c.instance;
      remapLink(c, toLocal);
      offsetObject(c, [-offset[0], -offset[1]]);
      return c;
    }),
  };
  updateDoc((d) => void (d.constructions = (d.constructions ?? []).map((t) => (t.id === tpl.id ? next : t))));
  syncInstances(tpl.id);
}

/** Regenerate every linked instance of a template, keeping ids, names and input values. */
export function syncInstances(templateId: string) {
  const t = allTemplates().find((x) => x.id === templateId);
  if (!t) return;
  updateDoc((d) => {
    const insts = [...new Set(d.objects.filter((o) => o.instance?.template === templateId && o.instance.linked).map((o) => o.instance!.instance))];
    for (const inst of insts) {
      const old = d.objects.filter((o) => o.instance?.instance === inst);
      const keep = new Map(old.map((o) => [o.instance!.local, o]));
      const meta = old[0].instance!;
      const { objs } = build(d, t, meta.inputs ?? defaultInputs(t), meta.offset ?? [0, 0], inst, true, keep);
      const gone = old.filter((o) => !t.objects.some((x) => x.id === o.instance!.local)).map((o) => o.name);
      const fresh = new Map(objs.map((o) => [o.id, o]));
      d.objects = d.objects.filter((o) => !old.includes(o) || fresh.has(o.id)).map((o) => fresh.get(o.id) ?? o);
      d.objects.push(...objs.filter((o) => !old.some((x) => x.id === o.id)));
      forgetObjects(d, layout(d, getState().timeline), new Set(gone), new Set(old.filter((o) => gone.includes(o.name)).map((o) => o.id)));
    }
    sortByDependencies(d);
  });
}
