import { useState } from 'react';
import { addAnimation, deleteSelection, duplicateObject, renameObject, setState, toast, updateDoc, useSignature, useStore } from '../store';
import type { AnimEntry, Args, Param, SceneObject, Step } from '../types';
import { Field, ParamField, quote, unquote } from './ParamField';

const TEXT_CTORS = new Set(['Text', 'Tex', 'MathTex', 'MarkupText', 'Paragraph', 'Title', 'SingleStringMathTex']);
const QUICK_ANIMS = ['Create', 'Write', 'FadeIn', 'FadeOut', 'Indicate', 'Circumscribe', 'Transform', 'ReplacementTransform', 'GrowFromCenter', 'Uncreate'];

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  let body;
  if (selection?.kind === 'object') {
    const obj = doc.objects.find((o) => o.id === selection.id);
    body = obj ? <ObjectInspector key={obj.id} obj={obj} /> : null;
  } else if (selection?.kind === 'step' || selection?.kind === 'anim') {
    const sid = selection.kind === 'step' ? selection.id : selection.stepId;
    const step = doc.steps.find((s) => s.id === sid);
    if (step) {
      const anim = selection.kind === 'anim' && step.kind === 'play' ? step.anims.find((a) => a.id === selection.id) : undefined;
      body = <StepInspector key={step.id} step={step} anim={anim} />;
    }
  }
  return <aside className="panel inspector"><div className="scroll">{body ?? <SceneInfo />}</div></aside>;
}

function SceneInfo() {
  const catalog = useStore((s) => s.catalog);
  const doc = useStore((s) => s.doc);
  return (
    <div className="pad">
      <h3>Scene</h3>
      <p className="muted">
        <b>{doc.scene.name}</b>({doc.scene.base}) · {doc.config.pixel_width}×{doc.config.pixel_height} @ {doc.config.frame_rate}fps
      </p>
      <button onClick={() => setState({ panel: 'settings' })}>Scene settings…</button>
      <h4>How it works</h4>
      <ul className="tips">
        <li>Drag any manim class from the library onto the canvas. Everything in <code>manim</code> is there, including classes defined in your header code.</li>
        <li>Every field takes Python, like <code>BLUE</code>, <code>UP * 2</code> or <code>lambda x: x**2</code>.</li>
        <li>Drag objects to position them. Turn on <b>Record</b> to animate the move instead.</li>
        <li>Use <b>Code</b> blocks in the timeline for anything else, such as updaters or ValueTrackers.</li>
        <li>Preview frames come from manim itself, so the final video matches them exactly.</li>
      </ul>
      {catalog && !catalog.latex && (
        <div className="warn">LaTeX was not found, so <code>MathTex</code> and <code>Tex</code> won't render. Install TeX Live, MacTeX or MiKTeX. <code>Text</code> works without it.</div>
      )}
      {catalog && <p className="muted small">manim {catalog.manim_version}</p>}
    </div>
  );
}

function setObj(id: string, fn: (o: SceneObject) => void, key: string) {
  updateDoc((d) => {
    const o = d.objects.find((x) => x.id === id);
    if (o) fn(o);
  }, `${id}:${key}`);
}

function ObjectInspector({ obj }: { obj: SceneObject }) {
  const sig = useSignature(obj.ctor);
  const objects = useStore((s) => s.doc.objects);
  const methods = useStore((s) => s.catalog?.methods ?? []);
  const content = TEXT_CTORS.has(obj.ctor) ? unquote(obj.args['*'] ?? '') : null;

  const commitName = (v: string) => {
    if (v === obj.name) return;
    if (!/^[A-Za-z_]\w*$/.test(v)) return toast('Name must be a valid Python identifier');
    if (objects.some((o) => o.name === v)) return toast(`"${v}" is already used`);
    renameObject(obj.id, v);
  };

  return (
    <div className="pad">
      <div className="insp-head">
        <Field value={obj.name} onChange={() => undefined} onBlur={commitName} className="mono name" />
        <span className="muted">=</span>
        <Field value={obj.ctor} onChange={(v) => setObj(obj.id, (o) => void (o.ctor = v), 'ctor')} list="me-mobjects" className="mono" />
      </div>
      {sig?.doc && <p className="doc">{sig.doc}</p>}
      {sig?.unknown && <p className="warn small">Unknown constructor. It will still be passed to Python as written.</p>}

      {(content !== null || (TEXT_CTORS.has(obj.ctor) && !obj.args['*'])) && (
        <section>
          <h4>{obj.ctor === 'Text' || obj.ctor === 'MarkupText' || obj.ctor === 'Paragraph' ? 'Text' : 'LaTeX'}</h4>
          <Field multiline className="mono content" value={content ?? ''} onChange={(v) => setObj(obj.id, (o) => void (o.args['*'] = quote(v)), 'content')} />
        </section>
      )}

      <section>
        <h4>Position</h4>
        <div className="row">
          <label className="mini">x <Field className="num" value={obj.pos ? String(obj.pos[0]) : ''} placeholder="auto" onChange={(v) => setPos(obj, 0, v)} /></label>
          <label className="mini">y <Field className="num" value={obj.pos ? String(obj.pos[1]) : ''} placeholder="auto" onChange={(v) => setPos(obj, 1, v)} /></label>
          {obj.pos && <button className="ghost" title="Let manim position it" onClick={() => setObj(obj.id, (o) => void (o.pos = null), 'pos')}>auto</button>}
        </div>
      </section>

      <ArgsEditor params={sig?.params ?? []} args={obj.args} hideStar={content !== null} onChange={(k, v) => setObj(obj.id, (o) => setArg(o.args, k, v), 'arg:' + k)} />

      <section>
        <h4>
          Method chain{' '}
          <select className="inline" value="" onChange={(e) => setObj(obj.id, (o) => void (o.chain = (o.chain ? o.chain + '\n' : '') + `.${e.target.value}()`), 'chain-add')}>
            <option value="">+ method</option>
            {methods.map((m) => <option key={m}>{m}</option>)}
          </select>
        </h4>
        <Field multiline className="mono" value={obj.chain} placeholder=".scale(0.8).set_fill(BLUE, opacity=0.5)" onChange={(v) => setObj(obj.id, (o) => void (o.chain = v), 'chain')} />
      </section>

      <section>
        <h4>Animate</h4>
        <div className="chips">
          {QUICK_ANIMS.map((a) => <button key={a} className="chip" onClick={() => addAnimation(a, obj.name)}>{a}</button>)}
          <button className="chip" onClick={() => addAnimation('animate', obj.name)}>.animate</button>
        </div>
      </section>

      <div className="row actions">
        <button onClick={() => duplicateObject(obj.id)}>Duplicate</button>
        <button className="danger" onClick={deleteSelection}>Delete</button>
      </div>
    </div>
  );
}

function setPos(obj: SceneObject, i: 0 | 1, v: string) {
  const n = parseFloat(v);
  if (v.trim() === '' || Number.isNaN(n)) return;
  setObj(obj.id, (o) => {
    const p: [number, number] = o.pos ? [...o.pos] : [0, 0];
    p[i] = n;
    o.pos = p;
  }, 'pos' + i);
}

function setArg(args: Args, k: string, v: string) {
  if (v.trim() === '') delete args[k];
  else args[k] = v;
}

function ArgsEditor({ params, args, onChange, hideStar }: { params: Param[]; args: Args; onChange: (k: string, v: string) => void; hideStar?: boolean }) {
  const [more, setMore] = useState(false);
  const shown = params.filter((p) => !(hideStar && p.name === '*'));
  const primary = shown.filter((p) => !p.from || p.required || args[p.name] !== undefined);
  const inherited = shown.filter((p) => !primary.includes(p));
  const known = new Set(params.map((p) => p.name));
  const extra = Object.keys(args).filter((k) => !known.has(k) && !(hideStar && k === '*'));
  const [newKey, setNewKey] = useState('');
  return (
    <section>
      <h4>Arguments</h4>
      {primary.map((p) => <ParamField key={p.name} param={p} value={args[p.name] ?? ''} onChange={(v) => onChange(p.name, v)} />)}
      {extra.map((k) => (
        <ParamField key={k} param={{ name: k, label: k, kind: 'expr', default: '', required: false, annotation: '', from: '' }} value={args[k]} onChange={(v) => onChange(k, v)} />
      ))}
      {inherited.length > 0 && (
        <>
          <button className="ghost small" onClick={() => setMore(!more)}>
            {more ? '▾' : '▸'} {inherited.length} more ({[...new Set(inherited.map((p) => p.from))].join(', ')})
          </button>
          {more && inherited.map((p) => <ParamField key={p.name} param={p} value={args[p.name] ?? ''} onChange={(v) => onChange(p.name, v)} />)}
        </>
      )}
      <div className="row">
        <input className="field mono" placeholder="other_kwarg" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <button className="ghost" disabled={!/^\w+$/.test(newKey)} onClick={() => { onChange(newKey, 'None'); setNewKey(''); }}>+ kwarg</button>
      </div>
    </section>
  );
}

function setStep(id: string, fn: (s: Step) => void, key: string) {
  updateDoc((d) => {
    const s = d.steps.find((x) => x.id === id);
    if (s) fn(s);
  }, `${id}:${key}`);
}

function StepInspector({ step, anim }: { step: Step; anim?: AnimEntry }) {
  const objects = useStore((s) => s.doc.objects);
  const rateFuncs = useStore((s) => s.catalog?.rate_funcs ?? []);
  const timing = useStore((s) => s.timeline?.steps.find((t) => t.id === step.id));
  return (
    <div className="pad">
      <div className="insp-head">
        <h3>{step.kind === 'play' ? 'self.play' : step.kind === 'wait' ? 'self.wait' : step.kind === 'code' ? 'Code block' : `self.${step.kind}`}</h3>
        {timing && <span className="muted small">{timing.start.toFixed(2)}s → {timing.end.toFixed(2)}s</span>}
      </div>

      {step.kind === 'play' && (
        <>
          <section>
            {step.anims.map((a) => (
              <div key={a.id} className={`anim-row ${anim?.id === a.id ? 'sel' : ''}`} onClick={() => setState({ selection: { kind: 'anim', stepId: step.id, id: a.id } })}>
                <span className="mono">{a.cls === 'animate' ? `${a.target}.animate${(a.chain ?? '').split('\n').join('')}` : `${a.cls}(${a.target})`}</span>
              </div>
            ))}
            <button className="ghost small" onClick={() => addAnimation('Indicate', anim?.target ?? step.anims[0]?.target ?? objects[0]?.name ?? '', step.id)}>+ animation in parallel</button>
          </section>
          {anim && <AnimEditor step={step} anim={anim} />}
          <section>
            <h4>Play options</h4>
            <label className="param"><span className="pname">run_time</span><Field className="num" value={step.run_time ?? ''} placeholder="per animation" onChange={(v) => setStep(step.id, (s) => void ((s as { run_time?: string }).run_time = v), 'rt')} /></label>
            <label className="param">
              <span className="pname">rate_func</span>
              <select className="field" value={step.rate_func ?? ''} onChange={(e) => setStep(step.id, (s) => void ((s as { rate_func?: string }).rate_func = e.target.value), 'rf')}>
                <option value="">per animation</option>
                {rateFuncs.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            {step.anims.length > 1 && (
              <label className="param"><span className="pname">lag_ratio</span><Field className="num" value={step.lag_ratio ?? ''} placeholder="0 = together" onChange={(v) => setStep(step.id, (s) => void ((s as { lag_ratio?: string }).lag_ratio = v), 'lag')} /></label>
            )}
          </section>
        </>
      )}

      {step.kind === 'wait' && (
        <label className="param"><span className="pname">duration</span><Field className="num" value={step.duration} onChange={(v) => setStep(step.id, (s) => void ((s as { duration: string }).duration = v), 'dur')} /></label>
      )}

      {step.kind === 'code' && (
        <section>
          <p className="muted small">Runs inside <code>construct(self)</code>, so every object variable is in scope.</p>
          <Field multiline className="mono code-input" value={step.code} onChange={(v) => setStep(step.id, (s) => void ((s as { code: string }).code = v), 'code')} />
        </section>
      )}

      {(step.kind === 'add' || step.kind === 'remove') && (
        <section>
          {objects.map((o) => (
            <label key={o.id} className="check">
              <input type="checkbox" checked={step.targets.includes(o.name)} onChange={(e) => setStep(step.id, (s) => {
                const st = s as { targets: string[] };
                st.targets = e.target.checked ? [...st.targets, o.name] : st.targets.filter((t) => t !== o.name);
              }, 'targets')} />
              <span className="mono">{o.name}</span>
            </label>
          ))}
        </section>
      )}

      <div className="row actions">
        <label className="check"><input type="checkbox" checked={!step.disabled} onChange={(e) => setStep(step.id, (s) => void (s.disabled = !e.target.checked), 'dis')} /> enabled</label>
        <button className="danger" onClick={() => { setState({ selection: { kind: 'step', id: step.id } }); deleteSelection(); }}>Delete step</button>
      </div>
    </div>
  );
}

function AnimEditor({ step, anim }: { step: Step; anim: AnimEntry }) {
  const sig = useSignature(anim.cls === 'animate' ? '' : anim.cls);
  const set = (fn: (a: AnimEntry) => void, key: string) =>
    setStep(step.id, (s) => {
      if (s.kind !== 'play') return;
      const a = s.anims.find((x) => x.id === anim.id);
      if (a) fn(a);
    }, anim.id + key);
  return (
    <section className="anim-editor">
      <div className="insp-head">
        <Field className="mono" value={anim.cls} list="me-animations" onChange={(v) => set((a) => void (a.cls = v), 'cls')} />
        <span className="muted">(</span>
        <Field className="mono" value={anim.target} list="me-targets" onChange={(v) => set((a) => void (a.target = v), 'target')} />
        <span className="muted">)</span>
      </div>
      {sig?.doc && <p className="doc">{sig.doc}</p>}
      {anim.cls === 'animate' ? (
        <>
          <h4>Methods to animate</h4>
          <Field multiline className="mono" value={anim.chain ?? ''} placeholder=".shift(RIGHT * 2).rotate(PI / 2)" onChange={(v) => set((a) => void (a.chain = v), 'chain')} />
        </>
      ) : (
        <ArgsEditor params={sig?.params ?? []} args={anim.args} onChange={(k, v) => set((a) => setArg(a.args, k, v), 'arg:' + k)} />
      )}
      <button className="ghost small danger" onClick={() => { setState({ selection: { kind: 'anim', stepId: step.id, id: anim.id } }); deleteSelection(); }}>Remove animation</button>
    </section>
  );
}
