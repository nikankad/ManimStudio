import { useLayoutEffect, useState } from 'react';
import { getState, selectObjects, setState, useStore } from '../store';
import { IN } from '../clipRole';
import { walk } from '../timeline';
import { keys } from '../keys';

/** Start the guided first animation (Help › Try this): a checklist that ticks itself as the scene gets there. */
export function startTryThis() {
  setState({ tryThis: { played: false, exported: false }, panel: null, panelData: null, tour: null });
}

const MOVES = /\.(shift|move_to|next_to|to_edge|to_corner|set_x|set_y|align_to)\(/;

/** Draw attention to a part of the window for a moment. */
function flash(selector: string) {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    el.classList.remove('try-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('try-flash');
    setTimeout(() => el.classList.remove('try-flash'), 1800);
  }
}

/**
 * Try this: add a circle, reveal it, move it, preview, export, all with the controls (no code). Each step is ticked
 * from the scene itself, so any way of doing it counts. It sits over the canvas without blocking anything else, and
 * closes with ×.
 */
export function TryThis() {
  const task = useStore((s) => s.tryThis);
  const doc = useStore((s) => s.doc);
  const home = useStore((s) => s.home);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!task) return;
    const place = () => {
      const r = document.querySelector('[data-tour="canvas"]')?.getBoundingClientRect();
      setPos(r ? { left: r.left + 12, bottom: window.innerHeight - r.bottom + 12 } : null);
    };
    place();
    window.addEventListener('resize', place);
    const t = window.setInterval(place, 1000); // the timeline's splitter moves the canvas too
    return () => {
      window.removeEventListener('resize', place);
      clearInterval(t);
    };
  }, [!!task]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!task || home) return null;

  const circle = doc.objects.find((o) => o.ctor === 'Circle');
  const anims = circle ? doc.timeline.filter((s) => !s.disabled).flatMap((s) => [...walk(s.anims)]).filter((a) => !a.disabled && a.target === circle.name) : [];
  const selectCircle = () => circle && selectObjects([circle.id]);
  const steps = [
    {
      title: 'Add a circle',
      done: !!circle,
      how: <>Double-click <b>Circle</b> in the Library (or press <kbd>/</kbd>, type <i>circle</i> and press <kbd>Enter</kbd>).</>,
      show: () => flash('[data-tour="library"]'),
    },
    {
      title: 'Reveal it',
      done: anims.some((a) => IN.test(a.cls)),
      how: <>With <b>Auto-intro</b> on, adding it already put a <b>Create</b> clip on the timeline. If not: select the circle and click <b>Create</b> under <i>Animate at playhead</i>.</>,
      show: () => { selectCircle(); flash('.inspector'); },
    },
    {
      title: 'Move it',
      done: anims.some((a) => (a.cls === 'animate' && MOVES.test(a.chain ?? '')) || a.cls === 'MoveAlongPath'),
      how: <>Select the circle and click <b>.animate</b> under <i>Animate at playhead</i>: it slides right. Or turn on <b>● Record</b> and drag the circle on the canvas.</>,
      show: () => { selectCircle(); flash('.inspector'); },
    },
    {
      title: 'Preview it',
      done: task.played,
      how: <>Press <kbd>Space</kbd> (or ▶ under the canvas) to play the scene.</>,
      show: () => flash('.transport .play'),
    },
    {
      title: 'Export it',
      done: task.exported,
      how: <>Click <b>Export video</b>, then <b>Render with manim</b>, and choose where to save it.</>,
      show: () => flash('[data-tour="output"]'),
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  const close = () => setState({ tryThis: null });
  return (
    <div className="try-this" role="region" aria-label="Try this: your first animation" style={pos ?? undefined}>
      <div className="row">
        <b>Try this: your first animation</b>
        <span className="spacer" />
        <button className="x-btn" aria-label="Close Try this" title="Close (you can start it again from Help)" onClick={close}>×</button>
      </div>
      <ol className="try-steps">
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
            <span className="try-check" aria-hidden>{s.done ? '✓' : i + 1}</span>
            <div>
              <span className="try-title"><span className="sr-only">{s.done ? 'Done: ' : ''}</span>{s.title}</span>
              {i === current && (
                <div className="muted small try-how">
                  {s.how} <button className="ghost small" onClick={s.show}>Show me</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {current < 0 && (
        <div className="small try-done">
          Done: a whole animation without code. The video is rendering; the Export window says when it is saved. <kbd>{keys('⌘S')}</kbd> saves the project.
          <div className="row"><span className="spacer" /><button className="primary" onClick={close}>Close</button></div>
        </div>
      )}
    </div>
  );
}

/** Steps that depend on what happened, not on the scene: playback started, an export started. */
export function noteTry(what: 'played' | 'exported') {
  const t = getState().tryThis;
  if (t && !t[what]) setState({ tryThis: { ...t, [what]: true } });
}
