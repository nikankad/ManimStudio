// What an animation does to its objects' presence, drawn on its clip like a transition in a video editor: an intro
// brings an object on screen (a ramp up), an outro takes it off (a ramp down), a swap does both (a cross dissolve,
// ReplacementTransform(a, b)), anything else is an effect with a keyframe at each end.
// Read from what manim reported was on screen before and after each self.play (RunResult.steps[].before / .after);
// until it has, guessed from the class name.

import { isMeasured, targetsOf, walk } from './timeline';
import type { Anim, RunResult, SceneDoc } from './types';

export type ClipRole = 'in' | 'out' | 'swap' | 'effect';

export const IN = /^(Create|Write|DrawBorderThenFill|FadeIn|Grow\w*|SpinInFromNothing|AddText\w*|ShowIncreasingSubsets|TypeWithCursor|SpiralIn)$/;
const OUT = /^(Uncreate|Unwrite|FadeOut|ShrinkToCenter|RemoveText\w*|UntypeWithCursor)$/;
const SWAP = /^(ReplacementTransform|TransformMatching\w*|FadeTransform\w*|TransformFromCopy)$/;

/** Names an animation refers to: its target(s), and objects named in its arguments (a transform's target). */
function namesIn(a: Anim): string[] {
  const out = [...targetsOf(a)];
  for (const v of Object.values(a.args ?? {})) for (const m of v.matchAll(/(^|[^\w.])([A-Za-z_]\w*)/g)) out.push(m[2]);
  return out;
}

export function clipRoles(doc: SceneDoc, measured: RunResult | null): Map<string, ClipRole> {
  const roles = new Map<string, ClipRole>();
  const idOf = new Map(doc.objects.map((o) => [o.name, o.id]));
  const shown = new Map((measured?.steps ?? []).filter((s) => s.after).map((s) => [s.id, s]));
  for (const step of doc.timeline) {
    if (step.kind !== 'play') continue;
    const m = isMeasured(step, measured) ? shown.get(step.id) : undefined;
    for (const a of walk(step.anims)) {
      if (a.anims?.length) continue; // a composition: its animations have their own roles
      roles.set(a.id, m ? measuredRole(a, m.before!, m.after!, idOf) : guessed(a));
    }
  }
  return roles;
}

function guessed(a: Anim): ClipRole {
  return IN.test(a.cls) ? 'in' : OUT.test(a.cls) ? 'out' : SWAP.test(a.cls) ? 'swap' : 'effect';
}

function measuredRole(a: Anim, before: string[], after: string[], idOf: Map<string, string>): ClipRole {
  if (a.cls === 'animate') return 'effect'; // moving or restyling: what plays alongside it is the intro or outro
  let comes = false, goes = false;
  for (const name of new Set(namesIn(a))) {
    const id = idOf.get(name);
    if (!id) continue;
    const b = before.includes(id), af = after.includes(id);
    if (!b && af) comes = true;
    if (b && !af) goes = true;
  }
  return comes && goes ? 'swap' : comes ? 'in' : goes ? 'out' : 'effect';
}
