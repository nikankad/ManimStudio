// A loop written in math: "k from 1 to 6" or "each item of a list" (Step.repeat). codegen writes its for header
// (mathengine/defs.py repeat_head); the step's head follows it, so the timeline and the code show the same thing.

import { useEffect, useState } from 'react';
import { api } from '../api';
import { updateDoc, useStore } from '../store';
import { findStep, loopsAround } from '../timeline';
import type { Repeat, Step } from '../types';
import { Field } from './ParamField';

type Mode = 'range' | 'each' | 'code';

function setRepeat(id: string, fn: (s: Step) => void, key: string) {
  updateDoc((d) => {
    const s = findStep(d, id);
    if (s) fn(s);
  }, `${id}:${key}`);
}

/** The Repeat of a block step, or a switch to make one; `children`: the header field, for a loop written in code. */
export function RepeatFields({ step, children }: { step: Step; children: React.ReactNode }) {
  const defs = useStore((s) => s.doc.defs);
  const timeline = useStore((s) => s.doc.timeline);
  const lists = (defs ?? []).filter((d) => d.kind === 'list').map((d) => d.name);
  const r = step.repeat;
  const mode: Mode = r ? (r.each !== undefined ? 'each' : 'range') : 'code';
  const outer = loopsAround(timeline, step.id).slice(0, r || /^\s*for\s/.test(step.head ?? '') ? -1 : undefined);
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null);

  // the header follows the Repeat
  const key = JSON.stringify([r, defs, outer]);
  useEffect(() => {
    if (!r) return setProblem(null);
    let live = true;
    const t = setTimeout(() => {
      api.repeatHead(r, defs, outer).then((res) => {
        if (!live) return;
        if (res.head) {
          setProblem(null);
          if (res.head !== step.head) setRepeat(step.id, (s) => void (s.head = res.head), 'repeat');
        } else setProblem({ error: res.error ?? 'This Repeat can’t be read.', hint: res.hint });
      }).catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<Repeat>) => setRepeat(step.id, (s) => void (s.repeat = { ...(s.repeat as Repeat), ...patch }), 'repeat');
  const switchTo = (m: Mode) => setRepeat(step.id, (s) => {
    const v = s.repeat?.var || /^\s*for\s+(\w+)/.exec(s.head ?? '')?.[1] || 'k';
    const count = /^\s*for\s+\w+\s+in\s+range\(\s*(\d+)\s*\)\s*$/.exec(s.head ?? '')?.[1];
    if (m === 'code') delete s.repeat;
    else if (m === 'range') s.repeat = { var: v, from: '1', to: count ?? '2' };
    else s.repeat = { var: v, each: lists[0] ?? '' };
  }, 'mode');

  return (
    <>
      <div className="fx-row wide-row"><span>Loop</span>
        <select className="field" aria-label="Loop kind" value={mode} onChange={(e) => switchTo(e.target.value as Mode)}>
          <option value="range">a counter, from … to …</option>
          <option value="each">each item of a list</option>
          <option value="code">as its header says (code)</option>
        </select>
      </div>
      {mode === 'code' && children}
      {r && (
        <div className="row repeat-row">
          <Field className="mono repeat-var" value={r.var} ariaLabel="Counter" onChange={(v) => change({ var: v.trim() })} />
          {mode === 'range' ? (
            <>
              <span className="muted small">from</span>
              <Field className="mono" value={r.from ?? '1'} ariaLabel="From" onChange={(v) => change({ from: v })} />
              <span className="muted small">to</span>
              <Field className="mono" value={r.to ?? ''} ariaLabel="To" placeholder="6, len(ZEROS)…" onChange={(v) => change({ to: v })} />
            </>
          ) : (
            <>
              <span className="muted small">in</span>
              <select className="field mono" aria-label="List" value={r.each ?? ''} onChange={(e) => change({ each: e.target.value })}>
                {!lists.includes(r.each ?? '') && <option value={r.each ?? ''}>{r.each || '(choose a list)'}</option>}
                {lists.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </>
          )}
        </div>
      )}
      {r && (problem
        ? <div className="err-box">{problem.error}{problem.hint ? <> {problem.hint}</> : null}</div>
        : <p className="muted small">
          {mode === 'range' ? <>Both ends included. </> : <>{lists.length ? '' : 'Make a list in Scene › Definitions (+ list). '}</>}
          Math fields of what is created in it can use <code>{r.var}</code>{mode === 'range' ? <> (e.g. <code>ZEROS[{r.var}]</code>)</> : null}. In the code: <code>{step.head}</code>
        </p>)}
    </>
  );
}
