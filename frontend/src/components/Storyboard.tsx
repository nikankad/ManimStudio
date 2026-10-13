import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { dependentsOf, describeLink, geoType, objectDeps } from '../construct';
import { pyQuote } from '../pyparse';
import { actionName, appendToBeat, beatBoundary, beatsFor, beatSpan, blankBeat, moveBeat, splitBeat, statementUnits, stepName } from '../storyboard';
import { addBeatSteps, docLayout, frameSnap, getState, playRange, projectEpoch, selectedObjectIds, selectObjects, setPlaying, setState, toast, uid, updateDoc, useStore, wrapInBlock } from '../store';
import { findAnim, newAnim, removeIds, walk } from '../timeline';
import type { Anim, Beat, SceneDoc, Step } from '../types';
import { allTemplates } from '../templates';
import { Library } from './Library';
import { Viewport } from './Viewport';
import { ActionsSection } from './Construction';
import { EquationSection, TermsClipEditor } from './EquationEditor';

function editBeat(id: string, fn: (b: Beat) => void, coalesce?: string) {
  updateDoc((d) => {
    const beats = beatsFor(d), beat = beats.find((b) => b.id === id);
    if (beat) fn(beat);
    d.storyboard = { beats };
  }, coalesce);
}
function selectBeat(beat: Beat) {
  const s = getState(), beats = beatsFor(s.doc), span = beatSpan(beat, beats, docLayout());
  setPlaying(false);
  setState({ activeBeat: beat.id, selection: null, targetEdit: false, canvasPhase: 'result', time: frameSnap(span.end), range: { in: null, out: null } });
}
export function WorkspaceSwitch() {
  const workspace = useStore((s) => s.workspace);
  return <div className="workspace-switch" role="group" aria-label="Authoring workspace">{(['storyboard', 'timeline'] as const).map((w) => <button key={w} className={workspace === w ? 'on' : ''} onClick={() => { setPlaying(false); setState({ workspace: w, targetEdit: false, record: false, range: { in: null, out: null } }); }} title={w === 'storyboard' ? 'Plan explanation beats and edit their native Manim actions' : 'Review precise timing in the timeline'}>{w === 'storyboard' ? 'Storyboard' : 'Timeline'}</button>)}</div>;
}

// Thumbnail requests are lazy, sequential and cancellable before execution. The native frame is never fabricated.
let thumbnailQueue: Promise<unknown> = Promise.resolve();
const thumbnails = new Map<string, string>();
function Thumbnail({ doc, time, beat }: { doc: SceneDoc; time: number; beat: Beat }) {
  const el = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [image, setImage] = useState<string | null>(null);
  const visual = useMemo(() => JSON.stringify({ ...doc, storyboard: undefined, markers: undefined, constructions: undefined }), [doc]);
  const key = `${visual}:${time}:${beatBoundary(doc, beat, 'end')?.id}`;
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (el.current) observer.observe(el.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    setImage(thumbnails.get(key) ?? null);
    if (!visible || thumbnails.has(key) || !doc.timeline.length) return;
    const opened = projectEpoch();
    const timer = setTimeout(() => {
      thumbnailQueue = thumbnailQueue.catch(() => undefined).then(async () => {
        if (cancelled || opened !== projectEpoch()) return;
        const frame = await api.run(doc, time, true, 240, beatBoundary(doc, beat, 'end'));
        if (cancelled || opened !== projectEpoch() || frame.error || !frame.image) return;
        thumbnails.set(key, frame.image);
        if (thumbnails.size > 24) thumbnails.delete(thumbnails.keys().next().value!);
        setImage(frame.image);
      }).catch(() => undefined);
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, visible]);
  return <div className="beat-thumbnail" ref={el}>{image ? <img src={image} alt="Native Manim result frame" /> : <span>{doc.timeline.length ? 'Native preview' : 'Blank canvas'}</span>}</div>;
}

export function StoryboardNavigator() {
  const doc = useStore((s) => s.doc), active = useStore((s) => s.activeBeat), measured = useStore((s) => s.timeline);
  const [library, setLibrary] = useState(false);
  const beats = useMemo(() => beatsFor(doc), [doc]), lay = docLayout(doc, measured);
  const current = beats.find((b) => b.id === active) ?? beats[0];
  const move = (b: Beat, delta: number) => {
    const copy = structuredClone(getState().doc), error = moveBeat(copy, b.id, delta);
    if (error) return toast(error);
    updateDoc((d) => { d.timeline = copy.timeline; d.storyboard = copy.storyboard; });
    selectBeat(beatsFor(getState().doc).find((x) => x.id === b.id)!);
  };
  return <aside className="storyboard-nav panel">
    <div className="storyboard-heading"><div><span className="eyebrow">EXPLANATION</span><h3>Your storyboard</h3></div><button title="Open the full object and animation library" className={library ? 'on' : ''} onClick={() => setLibrary(!library)}>Library</button></div>
    {library ? <div className="storyboard-library"><Library /></div> : <>
      <p className="storyboard-hint">What should the viewer understand next?</p>
      <div className="beat-list" role="list" aria-label="Explanation beats">{beats.map((b, i) => {
        const span = beatSpan(b, beats, lay);
        return <article role="listitem" key={b.id} className={`beat-card ${b.id === current.id ? 'selected' : ''}`}>
          <button className="beat-open" onClick={() => selectBeat(b)} aria-label={`Open beat ${i + 1}: ${b.title}`} aria-current={b.id === current.id ? 'step' : undefined}>
            <Thumbnail doc={doc} time={span.end} beat={b} />
            <div className="beat-card-title"><span className="beat-number">{String(i + 1).padStart(2, '0')}</span><strong>{b.title}</strong></div>
            <div className="beat-card-meta"><span>{b.steps.length} {b.steps.length === 1 ? 'action' : 'actions'}</span><span>{span.estimated ? '~' : ''}{(span.end - span.start).toFixed(2)}s</span></div>
            {b.script && <p className="beat-script-preview">{b.script}</p>}
          </button>
          <div className="beat-card-tools"><button disabled={!i} onClick={() => move(b, -1)} aria-label={`Move ${b.title} earlier`} title="Move earlier if its actions are independent">Earlier</button><button disabled={i === beats.length - 1} onClick={() => move(b, 1)} aria-label={`Move ${b.title} later`} title="Move later if its actions are independent">Later</button></div>
        </article>;
      })}</div>
      <button className="add-beat" onClick={() => {
        const b = blankBeat();
        updateDoc((d) => { const list = beatsFor(d); list.splice(list.findIndex((x) => x.id === current.id) + 1, 0, b); d.storyboard = { beats: list }; }); selectBeat(b);
      }}>+ Add explanation beat</button>
    </>}
  </aside>;
}

export function StoryboardWorkspace() {
  const doc = useStore((s) => s.doc), active = useStore((s) => s.activeBeat), measured = useStore((s) => s.timeline);
  const phase = useStore((s) => s.canvasPhase), targetEdit = useStore((s) => s.targetEdit), playing = useStore((s) => s.playing), time = useStore((s) => s.time);
  const [tab, setTab] = useState<'actions' | 'script' | 'relationships' | 'equations' | 'recipes'>('actions');
  const beats = useMemo(() => beatsFor(doc), [doc]), beat = beats.find((b) => b.id === active) ?? beats[0], lay = docLayout(doc, measured), span = beatSpan(beat, beats, lay);
  const boundary = phase === 'start' ? span.start : span.end;
  useEffect(() => {
    if (!playing && phase !== 'preview') setState({ time: frameSnap(boundary), activeBeat: beat.id });
  }, [beat.id, boundary, phase, playing]);
  const progress = span.end > span.start ? Math.min(1, Math.max(0, (time - span.start) / (span.end - span.start))) : 1;
  return <main className="storyboard-workspace">
    <div className="beat-statebar"><div className="beat-name"><span className="eyebrow">BEAT {beats.indexOf(beat) + 1} / {beats.length}</span><input value={beat.title} aria-label="Beat title" title="Name what the viewer learns in this beat" onChange={(e) => editBeat(beat.id, (b) => { b.title = e.target.value; }, `beat-title:${beat.id}`)} /></div>
      <div className="state-switch" role="group" aria-label="Beat state">{(['start', 'result'] as const).map((p) => <button key={p} className={phase === p ? 'on' : ''} onClick={() => { setPlaying(false); setState({ canvasPhase: p, targetEdit: false }); }}>{p === 'start' ? 'Start' : 'Result'}</button>)}</div>
      <button className={targetEdit ? 'on' : ''} disabled={phase === 'start' || playing} title="Drag an object to add a native move, scale or rotation action to this beat" onClick={() => setState({ canvasPhase: 'result', targetEdit: !targetEdit, tool: 'select' })}>Edit result</button>
      <button disabled={span.end <= span.start} title="Play only this beat using Manim's preview" onClick={() => {
        if (playing) { setPlaying(false); return; }
        setState({ canvasPhase: 'preview', targetEdit: false, loop: false, range: { in: span.start, out: span.end } }); playRange();
      }}>{playing ? 'Pause' : 'Preview beat'}</button>
    </div>
    <Viewport />
    <ChangeSummary beat={beat} /><div className="beat-progress"><span>{targetEdit ? 'Result edits become native actions' : phase === 'start' ? 'Before this explanation' : 'Native Manim preview'}</span><input type="range" min="0" max="1" step="0.001" aria-label="Beat progress" value={progress} onChange={(e) => { setPlaying(false); setState({ canvasPhase: 'preview', targetEdit: false, time: frameSnap(span.start + Number(e.target.value) * (span.end - span.start)) }); }} /><span>{(span.end - span.start).toFixed(2)}s {span.estimated ? '(estimated)' : ''}</span></div>
    <section className="beat-workbench">
      <div className="workbench-tabs" role="tablist" aria-label="Beat authoring tools">{(['actions', 'script', 'relationships', 'equations', 'recipes'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
      <div className="workbench-content" role="tabpanel" aria-label={tab}>
        {tab === 'actions' && <ActionFlow beat={beat} />}
        {tab === 'script' && <ScriptEditor beat={beat} />}
        {tab === 'relationships' && <Relationships />}
        {tab === 'equations' && <Equations beat={beat} />}
        {tab === 'recipes' && <Recipes />}
      </div>
    </section>
  </main>;
}

function ActionFlow({ beat }: { beat: Beat }) {
  const doc = useStore((s) => s.doc), measured = useStore((s) => s.timeline), selection = useStore((s) => s.selection);
  const lay = docLayout(doc, measured), ids = selectedObjectIds(selection), units = statementUnits(doc).filter((u) => beat.steps.includes(u[0].id));
  return <div className="action-workspace"><div className="flow-list">
    <div className="workbench-heading"><h4>Then</h4><span className="muted small">Native execution order</span><button disabled={!beat.steps.length} onClick={() => wrapInBlock(beat.steps, 'for _repeat_index in range(2)')} title="Repeat these actions twice. Select the Repeat block to edit its count.">Repeat</button><button disabled={!beat.steps.length} title="Combine this explanation and the following beat without changing code" onClick={() => {
      updateDoc((d) => { const list = beatsFor(d), i = list.findIndex((b) => b.id === beat.id), next = list[i + 1]; if (!next) return; list[i].steps.push(...next.steps); list[i].cues.push(...next.cues); list[i].script = [list[i].script, next.script].filter(Boolean).join('\n\n'); list.splice(i + 1, 1); d.storyboard = { beats: list }; });
    }}>Join next beat</button></div>
    {!units.length && <p className="empty-beat">Draw on the canvas or choose an object from Library. Add actions to show your explanation.</p>}
    {units.map((unit, i) => <div className="flow-unit" key={unit[0].id}>
      {i > 0 && <button className="beat-split" onClick={() => updateDoc((d) => { splitBeat(d, beat.id, unit[0].id); })} title="Start a new explanation here">Split into a beat here</button>}
      {unit.map((s) => <div className={`flow-step ${s.disabled ? 'disabled' : ''}`} key={s.id}>
        <button className={`flow-label ${selection?.kind === 'clips' && selection.ids.includes(s.id) ? 'on' : ''}`} onClick={() => setState({ selection: { kind: 'clips', ids: [s.id] }, time: lay.steps.get(s.id)?.start ?? 0, canvasPhase: 'preview', targetEdit: false })}><strong>{stepName(s)}</strong><span>{((lay.steps.get(s.id)?.end ?? 0) - (lay.steps.get(s.id)?.start ?? 0)).toFixed(2)}s</span></button>
        {s.kind === 'play' && <><div className="flow-composition"><span className="muted small">Play as</span><select aria-label={`Composition for ${s.id}`} value={s.anims?.length === 1 && s.anims[0].anims ? s.anims[0].cls : 'parallel'} onChange={(e) => updateDoc((d) => {
          const step = d.timeline.find((x) => x.id === s.id)!;
          // Changing a wrapper intentionally preserves its children and requires review of timing overrides.
          const children = step.anims?.length === 1 && step.anims[0].anims ? step.anims[0].anims : step.anims ?? [];
          step.anims = e.target.value === 'parallel' ? children : [{ ...newAnim(e.target.value, ''), args: e.target.value === 'LaggedStart' ? { lag_ratio: '0.2' } : {}, anims: children }];
        })}><option value="parallel">Together (self.play)</option><option value="AnimationGroup">Together (group)</option><option value="Succession">Then (succession)</option><option value="LaggedStart">Stagger</option></select></div>{s.anims?.map((a) => <AnimationNode key={a.id} anim={a} />)}</>}
        {s.kind === 'code' && <pre className="flow-code">{s.code}</pre>}
        {s.kind !== 'end' && <div className="flow-step-tools"><button onClick={() => updateDoc((d) => { d.timeline.find((x) => x.id === s.id)!.disabled = !s.disabled; })}>{s.disabled ? 'Enable' : 'Disable'}</button><button title="Remove this action (a block is removed as a whole)" onClick={() => updateDoc((d) => removeIds(d, docLayout(d), new Set([s.id]), 'ripple'))}>Remove</button></div>}
      </div>)}
    </div>)}
  </div><div className="action-builder"><ActionBuilder /><ActionsSection ids={ids} terms={selection?.kind === 'object' ? selection.terms : undefined} /></div></div>;
}
function AnimationNode({ anim }: { anim: Anim }) {
  const selection = useStore((s) => s.selection), measured = useStore((s) => s.timeline), doc = useStore((s) => s.doc);
  const span = docLayout(doc, measured).anims.get(anim.id);
  return <div className={`flow-animation ${anim.anims ? 'composition' : ''}`}><button className={selection?.kind === 'clips' && selection.ids.includes(anim.id) ? 'on' : ''} onClick={() => setState({ selection: { kind: 'clips', ids: [anim.id] }, canvasPhase: 'preview', targetEdit: false, time: span?.start ?? 0 })} title="Select to edit native arguments in Properties"><span>{actionName(anim)}</span><small>{anim.disabled ? 'disabled' : `${span?.estimated ? '~' : ''}${((span?.end ?? 0) - (span?.start ?? 0)).toFixed(2)}s`}</small></button>{anim.anims?.map((a) => <AnimationNode key={a.id} anim={a} />)}</div>;
}

function ActionBuilder() {
  const doc = useStore((s) => s.doc), selection = useStore((s) => s.selection);
  const [kind, setKind] = useState('FadeIn'), [target, setTarget] = useState(''), [value, setValue] = useState('1'), [other, setOther] = useState(''), [duration, setDuration] = useState('1'), [easing, setEasing] = useState('smooth');
  const selected = doc.objects.find((o) => selectedObjectIds(selection).includes(o.id)), name = target || selected?.name || doc.objects[0]?.name || '';
  const add = () => {
    const t = Number(duration);
    if (!Number.isFinite(t) || t <= 0) return toast('Duration must be a positive number.');
    if (kind === 'wait') return addBeatSteps([{ id: uid('s'), kind: 'wait', args: { duration } }]);
    if (!doc.objects.some((o) => o.name === name)) return toast('Choose an object.');
    const a = newAnim(kind === 'parameter' || kind === 'move' ? 'animate' : kind, name);
    if (kind === 'parameter') {
      if (doc.objects.find((o) => o.name === name)?.ctor !== 'ValueTracker') return toast('Choose a ValueTracker parameter.');
      if (!value.trim()) return toast('Enter the result value.');
      a.chain = `.set_value(${value})`;
    } else if (kind === 'move') { if (!value.trim()) return toast('Enter a result position.'); a.chain = `.move_to(${value})`; }
    else if (kind === 'Rotate') a.args.angle = `${value} * DEGREES`;
    else if (kind === 'MoveAlongPath') { if (!other) return toast('Choose a path object.'); a.args.path = other; }
    else if (['Transform', 'ReplacementTransform'].includes(kind)) { if (!other || other === name) return toast('Choose a different destination object.'); a.args.target_mobject = other; }
    addBeatSteps([{ id: uid('s'), kind: 'play', anims: [a], args: { run_time: duration, rate_func: easing } }]);
  };
  return <div className="action-form"><h4>Show a change</h4><label>Action<select value={kind} onChange={(e) => { setKind(e.target.value); setValue(e.target.value === 'move' ? 'RIGHT * 2' : e.target.value === 'Rotate' ? '90' : '1'); }}>{[['FadeIn', 'Reveal'], ['Create', 'Draw'], ['Write', 'Write'], ['move', 'Move to position'], ['Rotate', 'Rotate'], ['MoveAlongPath', 'Follow path'], ['Transform', 'Morph (keep identity)'], ['ReplacementTransform', 'Replace object'], ['parameter', 'Change parameter'], ['FadeOut', 'Fade out'], ['Indicate', 'Emphasize'], ['wait', 'Hold']].map(([v, l]) => <option value={v} key={v}>{l}</option>)}</select></label>
    {kind !== 'wait' && <label>Object<select aria-label="Action object" value={name} onChange={(e) => setTarget(e.target.value)}><option value="">Choose object</option>{doc.objects.filter((o) => kind !== 'parameter' || o.ctor === 'ValueTracker').map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}</select></label>}
    {['parameter', 'move', 'Rotate'].includes(kind) && <label>{kind === 'Rotate' ? 'Degrees' : kind === 'move' ? 'Result position (Python)' : 'Result value'}<input value={value} onChange={(e) => setValue(e.target.value)} /></label>}
    {['MoveAlongPath', 'Transform', 'ReplacementTransform'].includes(kind) && <label>{kind === 'MoveAlongPath' ? 'Path' : 'Destination'}<select value={other} onChange={(e) => setOther(e.target.value)}><option value="">Choose object</option>{doc.objects.filter((o) => o.name !== name).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}</select></label>}
    <div className="action-timing"><label>Seconds<input type="number" min="0.01" step="0.1" value={duration} onChange={(e) => setDuration(e.target.value)} /></label><label>Easing<select value={easing} onChange={(e) => setEasing(e.target.value)}>{['smooth', 'linear', 'rush_into', 'rush_from', 'there_and_back'].map((v) => <option key={v}>{v}</option>)}</select></label></div>
    <button className="primary" onClick={add}>Add action to beat</button>
    <p className="muted small">Select an action to edit all its Manim arguments in Properties.</p>
  </div>;
}

function ScriptEditor({ beat }: { beat: Beat }) {
  const doc = useStore((s) => s.doc), measured = useStore((s) => s.timeline);
  const [phrase, setPhrase] = useState(''), [step, setStep] = useState(''), [edge, setEdge] = useState<'start' | 'end'>('start'), [audio, setAudio] = useState('');
  const steps = doc.timeline.filter((s) => beat.steps.includes(s.id)), lay = docLayout(doc, measured);
  return <div className="script-workspace"><div><h4>Explain this moment</h4><textarea aria-label="Beat narration" placeholder="Write what you want to say as the diagram changes…" value={beat.script} onChange={(e) => editBeat(beat.id, (b) => { b.script = e.target.value; }, `script:${beat.id}`)} /><p className="muted small">Cues attach phrases to action boundaries. Align recordings manually; speech timing is not inferred.</p><label>Audio file path<input aria-label="Narration audio path" placeholder="/path/to/narration.wav" value={audio} onChange={(e) => setAudio(e.target.value)} /></label><button disabled={!audio.trim()} onClick={() => {
    const call: Step = { id: uid('s'), kind: 'call', method: 'add_sound', args: { sound_file: pyQuote(audio.trim()) } };
    updateDoc((d) => { appendToBeat(d, beat.id, [call]); const b = d.storyboard!.beats.find((x) => x.id === beat.id)!; const first = b.steps[0]; d.timeline = d.timeline.filter((s) => s.id !== call.id); const at = d.timeline.findIndex((s) => s.id === first); d.timeline.splice(at < 0 ? d.timeline.length : at, 0, call); b.steps = [call.id, ...b.steps.filter((id) => id !== call.id)]; });
    toast('Audio starts at this beat. Export video to hear Manim’s audio mix.');
  }}>Attach audio at beat start</button></div><div><h4>Phrase cues</h4><label>Phrase<input aria-label="Cue phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} /></label><label>Action<select aria-label="Cue action" value={step} onChange={(e) => setStep(e.target.value)}><option value="">Choose action</option>{steps.map((s) => <option key={s.id} value={s.id}>{stepName(s)}</option>)}</select></label><label>Boundary<select value={edge} onChange={(e) => setEdge(e.target.value as 'start' | 'end')}><option value="start">Starts on phrase</option><option value="end">Finishes on phrase</option></select></label><button disabled={!phrase.trim() || !step || !beat.script.includes(phrase.trim())} onClick={() => { editBeat(beat.id, (b) => { b.cues.push({ id: uid('cue'), phrase: phrase.trim(), step, edge, offset: 0 }); }); setPhrase(''); }}>Attach phrase</button>
    {beat.cues.map((c) => { const t = (lay.steps.get(c.step)?.[c.edge] ?? 0) + c.offset; return <div className="phrase-cue" key={c.id}><button onClick={() => setState({ time: frameSnap(t), canvasPhase: 'preview', targetEdit: false })}>{c.phrase}<small>{t.toFixed(2)}s · {c.edge}</small></button>{!beat.script.includes(c.phrase) && <span className="warn small">Phrase changed; realign cue</span>}<label>Offset (seconds)<input aria-label={`Offset for ${c.phrase}`} type="number" step="0.1" value={c.offset} onChange={(e) => { const value = Number(e.target.value); if (Number.isFinite(value)) editBeat(beat.id, (b) => { b.cues.find((x) => x.id === c.id)!.offset = value; }); }} /></label><button onClick={() => editBeat(beat.id, (b) => { b.cues = b.cues.filter((x) => x.id !== c.id); })}>Remove cue</button></div>; })}
  </div></div>;
}

function Relationships() {
  const doc = useStore((s) => s.doc), selection = useStore((s) => s.selection), frame = useStore((s) => s.frame);
  const ids = selectedObjectIds(selection), dependents = dependentsOf(doc, ids);
  const objects = ids.length ? doc.objects.filter((o) => ids.includes(o.id) || dependents.some((d) => d.id === o.id) || ids.some((id) => { const selected = doc.objects.find((x) => x.id === id); return selected && objectDeps(selected, doc).includes(o.id); })) : doc.objects;
  return <div className="relationships-workspace"><div><h4>What drives the diagram</h4><p className="muted small">Select a node to inspect or change its construction. Parameters drive their connected objects.</p><ParameterLab /><div className="relationship-graph">{objects.map((o) => <div className={`relationship-node ${ids.includes(o.id) ? 'selected' : ''}`} key={o.id}>
    <div className="relationship-sources">{objectDeps(o, doc).map((id) => <button key={id} onClick={() => selectObjects([id])}>{doc.objects.find((x) => x.id === id)?.name} →</button>)}</div>
    <button className="relationship-object" onClick={() => selectObjects([o.id])}><strong>{o.name}</strong><small>{o.ctor === 'ValueTracker' ? `Parameter = ${frame?.values[o.name] ?? o.args['*']}` : o.link ? describeLink(o, doc) : o.ctor}</small></button>
  </div>)}</div>{!objects.length && <p>Build a diagram on the canvas to see its relationships.</p>}</div><div className="action-builder"><ActionBuilder /><p className="muted small">Imported procedural updaters remain in Code; this view shows declared construction dependencies.</p></div></div>;
}
function Equations({ beat }: { beat: Beat }) {
  const doc = useStore((s) => s.doc), selection = useStore((s) => s.selection);
  const equations = doc.objects.filter((o) => geoType(o, doc) === 'equation');
  const chosen = equations.find((o) => selectedObjectIds(selection).includes(o.id));
  const transform = selection?.kind === 'clips' ? findAnim(doc, selection.ids[0])?.anim : undefined;
  return <div className="equation-workspace"><div><h4>Formula states</h4><p className="muted small">Choose a formula, split it into terms, then pair it with its next state.</p>{equations.map((o, i) => <button className={`equation-state ${chosen?.id === o.id ? 'on' : ''}`} key={o.id} onClick={() => selectObjects([o.id])}><small>STATE {i + 1} · {o.name}</small><span>{o.eq?.parts.map((p) => p.tex).join(' ') ?? o.args['*']}</span></button>)}{!equations.length && <p>Add a MathTex object from Library to begin a derivation.</p>}
    <button disabled={!chosen?.eq?.parts.length || equations.filter((o) => o.id !== chosen.id && o.eq?.parts.length).length === 0} onClick={() => {
      const destination = equations.find((o) => o.id !== chosen?.id && o.eq?.parts.length)!;
      const a: Anim = { ...newAnim('TransformTerms', chosen!.name), terms: { to: destination.id, pairs: [] } };
      addBeatSteps([{ id: uid('s'), kind: 'play', anims: [a], args: { run_time: '1' } }]); setState({ selection: { kind: 'clips', ids: [a.id] } });
    }}>Connect to next formula</button><p className="muted small">{beat.title}: correspondence describes visual motion.</p></div><div>{transform?.cls === 'TransformTerms' ? <TermsClipEditor key={transform.id} anim={transform} onChange={(fn) => updateDoc((d) => fn(findAnim(d, transform.id)!.anim))} /> : chosen ? <EquationSection key={chosen.id} obj={chosen} /> : <p className="muted">Select a formula or a term transition to edit it.</p>}</div></div>;
}
function Recipes() {
  useStore((s) => s.doc); useStore((s) => s.library); useStore((s) => s.starters);
  const ids = useStore((s) => s.selection), templates = allTemplates();
  return <div className="recipe-workspace"><div className="workbench-heading"><h4>Reusable explanations</h4><button disabled={!selectedObjectIds(ids).length} onClick={() => setState({ panel: 'save-construction', panelData: selectedObjectIds(ids) })}>Save selection as recipe</button></div><div className="recipe-list">{templates.map((t) => <button className="recipe-card" key={t.id} onClick={() => setState({ panel: 'insert', panelData: t })}><strong>{t.name}</strong><span>{t.description}</span><small>{t.inputs.length} inputs · {t.timeline.length} actions</small></button>)}</div></div>;
}

function ChangeSummary({ beat }: { beat: Beat }) {
  const doc = useStore((s) => s.doc), measured = useStore((s) => s.timeline);
  const steps = doc.timeline.filter((s) => beat.steps.includes(s.id)), observations = measured?.anims ?? [];
  const summaries = steps.flatMap((s) => [...walk(s.anims)]).filter((a) => !a.anims).map((a) => {
    const observed = observations.find((x) => x.id === a.id), from = observed?.from, to = observed?.to;
    if (['Write', 'Create', 'FadeIn', 'FadeOut', 'Uncreate'].includes(a.cls)) return actionName(a);
    const round = (n: number) => Math.round(n * 100) / 100;
    if (from?.value !== undefined && to?.value !== undefined) return `${a.target}: ${round(from.value)} → ${round(to.value)}`;
    if (from?.center && to?.center && from.center.some((v, i) => Math.abs(v - to.center![i]) > .001)) return `${a.target}: (${from.center.map(round).join(', ')}) → (${to.center.map(round).join(', ')})`;
    if (from?.color && to?.color && from.color !== to.color) return `${a.target}: ${from.color} → ${to.color}`;
    return actionName(a);
  });
  return <div className="beat-changes" aria-label="Changes in this beat"><span>Changes</span>{summaries.slice(0, 5).map((s, i) => <span className="change-chip" key={i}>{s}</span>)}{summaries.length > 5 && <span>+{summaries.length - 5} more</span>}{!summaries.length && <span className="muted">{steps.length ? steps.map(stepName).slice(0, 3).join(' · ') : 'Plan a change for this explanation'}</span>}</div>;
}

/** Try a result value without rewriting the starting construction; commit one native parameter sweep. */
function ParameterLab() {
  const doc = useStore((s) => s.doc), frame = useStore((s) => s.frame), active = useStore((s) => s.activeBeat);
  const [draft, setDraft] = useState<{ name: string; value: number; source: SceneDoc } | null>(null);
  const [seconds, setSeconds] = useState('1');
  useEffect(() => { setDraft(null); setState({ previewDoc: null }); }, [active, doc]);
  useEffect(() => () => setState({ previewDoc: null }), []);
  const tryValue = (name: string, value: number) => {
    setPlaying(false);
    const copy = structuredClone(getState().doc), b = active ?? beatsFor(copy)[0].id;
    appendToBeat(copy, b, [{ id: 'parameter-lab-preview', kind: 'apply', target: name, chain: `.set_value(${value})` }]);
    setDraft({ name, value, source: doc }); setState({ previewDoc: copy, canvasPhase: 'result', targetEdit: false });
  };
  const parameters = doc.objects.filter((o) => o.ctor === 'ValueTracker');
  if (!parameters.length) return null;
  return <div className="parameter-lab"><h4>Try a parameter value</h4>{parameters.map((p) => {
    const value = draft?.name === p.name ? draft.value : frame?.values[p.name] ?? Number(p.args['*']);
    if (!Number.isFinite(value)) return null;
    const meta = p.param ?? { min: Math.min(-5, value), max: Math.max(5, value), step: .1 };
    return <label key={p.id}>{p.name} = {Math.round(value * 1000) / 1000}<input aria-label={`Try ${p.name}`} type="range" min={Math.min(meta.min, value)} max={Math.max(meta.max, value)} step={meta.step} value={value} onChange={(e) => tryValue(p.name, Number(e.target.value))} /></label>;
  })}{draft && <div className="parameter-draft"><label>Sweep duration (seconds)<input aria-label="Parameter sweep duration" type="number" min="0.01" step="0.1" value={seconds} onChange={(e) => setSeconds(e.target.value)} /></label><button className="primary" onClick={() => {
    if (!(Number(seconds) > 0) || !Number.isFinite(Number(seconds))) return toast('Enter a positive duration.');
    if (getState().doc !== draft.source) return toast('The scene changed. Try the parameter value again.');
    const a = { ...newAnim('animate', draft.name), chain: `.set_value(${draft.value})` };
    setState({ previewDoc: null }); setDraft(null); addBeatSteps([{ id: uid('s'), kind: 'play', anims: [a], args: { run_time: seconds, rate_func: 'smooth' } }]);
  }}>Save parameter sweep</button><button onClick={() => { setDraft(null); setState({ previewDoc: null }); }}>Discard result</button></div>}</div>;
}
