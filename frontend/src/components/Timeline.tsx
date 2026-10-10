import { useRef, useState } from 'react';
import { addAnimation, addStep, getState, setPlaying, setState, updateDoc, useStore } from '../store';
import type { Step } from '../types';
import { DND_TYPE, type DragPayload } from './Library';

const FALLBACK = 1; // width (s) for steps the analysis didn't reach

function label(step: Step): string {
  switch (step.kind) {
    case 'play':
      return step.anims.map((a) => (a.cls === 'animate' ? `${a.target}.animate${(a.chain ?? '').split('\n')[0]}` : `${a.cls}(${a.target})`)).join(' + ');
    case 'wait':
      return `wait(${step.duration})`;
    case 'code':
      return step.label || '{ } ' + (step.code.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? 'code');
    default:
      return `${step.kind}(${step.targets.join(', ')})`;
  }
}

interface Layout {
  id: string;
  start: number;
  dur: number;
  measured: boolean;
}

export function Timeline() {
  const doc = useStore((s) => s.doc);
  const timeline = useStore((s) => s.timeline);
  const lastGood = useStore((s) => s.lastGoodTimeline);
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const selection = useStore((s) => s.selection);
  const error = useStore((s) => s.frame?.error ?? s.timeline?.error);
  const [pps, setPps] = useState(80); // pixels per second
  const laneRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; mode: 'move' | 'resize'; x0: number; dx: number } | null>(null);

  // Lay steps out with measured timings; unmeasured steps get a fallback width after the last known end.
  const measured = new Map(timeline?.steps.map((s) => [s.id, s]) ?? []);
  const previous = new Map(lastGood?.steps.map((s) => [s.id, s.end - s.start]) ?? []);
  let cursor = 0;
  const layout: Layout[] = doc.steps.map((s) => {
    const m = measured.get(s.id);
    const prevDur = previous.get(s.id);
    if (s.disabled) return { id: s.id, start: cursor, dur: 0.3, measured: false };
    if (m) {
      cursor = m.end;
      return { id: s.id, start: m.start, dur: m.end - m.start, measured: true };
    }
    const dur = prevDur ?? FALLBACK;
    const l = { id: s.id, start: cursor, dur, measured: false };
    cursor += dur;
    return l;
  });
  const total = Math.max(cursor, timeline?.duration ?? 0);
  const width = Math.max(total + 4, 12) * pps;

  const timeAt = (clientX: number) => {
    const r = laneRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + laneRef.current!.scrollLeft) / pps));
  };

  const scrub = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPlaying(false);
    setState({ time: timeAt(e.clientX), showVideo: false });
  };

  const selStepId = selection?.kind === 'step' ? selection.id : selection?.kind === 'anim' ? selection.stepId : null;

  const finishDrag = () => {
    if (!drag) return;
    const step = doc.steps.find((s) => s.id === drag.id)!;
    const lay = layout.find((l) => l.id === drag.id)!;
    if (drag.mode === 'resize') {
      const newDur = Math.max(0.1, Math.round((lay.dur + drag.dx / pps) * 10) / 10);
      updateDoc((d) => {
        const s = d.steps.find((x) => x.id === drag.id)!;
        if (s.kind === 'play') s.run_time = String(newDur);
        if (s.kind === 'wait') s.duration = String(newDur);
      });
    } else if (Math.abs(drag.dx) > 4) {
      const center = lay.start + lay.dur / 2 + drag.dx / pps;
      const others = layout.filter((l) => l.id !== drag.id);
      let idx = others.findIndex((l) => center < l.start + l.dur / 2);
      if (idx < 0) idx = others.length;
      updateDoc((d) => {
        const from = d.steps.findIndex((s) => s.id === step.id);
        const [moved] = d.steps.splice(from, 1);
        d.steps.splice(idx, 0, moved);
      });
    }
    setDrag(null);
  };

  return (
    <div className="timeline">
      <div className="tl-bar">
        <button className="icon" title="Start (Home)" onClick={() => setState({ time: 0 })}>⏮</button>
        <button className="icon play" title="Play / pause (Space)" onClick={() => setPlaying(!playing)}>{playing ? '⏸' : '▶'}</button>
        <span className="mono time">{time.toFixed(2)}s / {total.toFixed(2)}s</span>
        <div className="spacer" />
        <button className="ghost" onClick={() => addStep('wait')}>+ Wait</button>
        <button className="ghost" onClick={() => addStep('code')}>+ Code</button>
        <button className="ghost" onClick={() => addStep('add')}>+ Add</button>
        <button className="ghost" onClick={() => addStep('remove')}>+ Remove</button>
        <input type="range" min={20} max={300} value={pps} onChange={(e) => setPps(+e.target.value)} title="Zoom" />
      </div>
      <div className="tl-scroll" ref={laneRef}>
        <div style={{ width, position: 'relative' }}>
          <div className="ruler" onPointerDown={scrub} onPointerMove={(e) => e.buttons && setState({ time: timeAt(e.clientX) })}>
            {Array.from({ length: Math.ceil(width / pps) + 1 }, (_, i) => (
              <div key={i} className="tick" style={{ left: i * pps }}>{i}s</div>
            ))}
          </div>
          <div className="lane" onPointerDown={(e) => e.target === e.currentTarget && scrub(e)}>
            {doc.steps.map((s, i) => {
              const l = layout[i];
              const isDrag = drag?.id === s.id;
              const left = l.start * pps + (isDrag && drag.mode === 'move' ? drag.dx : 0);
              const w = Math.max(8, l.dur * pps + (isDrag && drag.mode === 'resize' ? drag.dx : 0)) - 2;
              return (
                <div
                  key={s.id}
                  className={`block ${s.kind} ${selStepId === s.id ? 'sel' : ''} ${error?.id === s.id ? 'err' : ''} ${l.measured ? '' : 'unmeasured'} ${s.disabled ? 'disabled' : ''} ${isDrag ? 'dragging' : ''}`}
                  style={{ left, width: w }}
                  title={label(s)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const r = e.currentTarget.getBoundingClientRect();
                    const resizable = s.kind === 'play' || s.kind === 'wait';
                    setDrag({ id: s.id, mode: resizable && r.right - e.clientX < 8 ? 'resize' : 'move', x0: e.clientX, dx: 0 });
                    setState({ selection: { kind: 'step', id: s.id } });
                  }}
                  onPointerMove={(e) => drag?.id === s.id && setDrag({ ...drag, dx: e.clientX - drag.x0 })}
                  onPointerUp={finishDrag}
                  onDoubleClick={() => setState({ time: l.start + l.dur, showVideo: false })}
                  onDragOver={(e) => e.dataTransfer.types.includes(DND_TYPE) && s.kind === 'play' && e.preventDefault()}
                  onDrop={(e) => {
                    const payload = JSON.parse(e.dataTransfer.getData(DND_TYPE) || '{}') as DragPayload;
                    if (payload.kind !== 'animation' || s.kind !== 'play') return;
                    e.preventDefault();
                    const st = getState();
                    const sel = st.selection?.kind === 'object' ? st.doc.objects.find((o) => o.id === (st.selection as { id: string }).id) : undefined;
                    addAnimation(payload.name, sel?.name ?? s.anims[0]?.target ?? '', s.id);
                  }}
                >
                  <span className="block-label">{label(s)}</span>
                  {(s.kind === 'play' || s.kind === 'wait') && <span className="grip" />}
                </div>
              );
            })}
          </div>
          <div className="playhead" style={{ left: time * pps }} />
        </div>
      </div>
    </div>
  );
}
