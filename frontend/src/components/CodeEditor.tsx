import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, askPath, type CodeSpan, type LineKind } from '../api';
import { getState, selectClips, selectObjects, setState, toast, updateDoc, useStore } from '../store';
import type { SceneDoc } from '../types';
import { findAnim, rootName } from '../timeline';
import { importManimFile } from './Panels';
import { codeKeys, highlight } from './CodeArea';
import { keys } from '../keys';

type LineMap = Record<string, [LineKind, string]>;

/**
 * The scene as manim code, both ways: edits on the timeline, canvas or inspector rewrite the code, and edits
 * here (or a whole manim file pasted in) rewrite the scene. Code that is unchanged keeps what the editor knows
 * about it (constructions, equation terms, disabled clips); the rest is read the way manim runs it.
 */
export function CodeEditor() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const error = useStore((s) => s.frame?.error ?? s.timeline?.error);
  const image = useStore((s) => s.frame?.image);
  const [text, setText] = useState('');
  const [linemap, setLinemap] = useState<LineMap>({});
  const [spans, setSpans] = useState<Record<string, CodeSpan[]>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'pending' | 'error'; message: string; line?: number | null; notes?: string[] }>({ kind: 'ok', message: '' });
  const [live, setLive] = useState(true);
  const lines = useMemo(() => text.split('\n'), [text]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  // The document our own code edit produced, and the code text it came from: no need to rewrite the editor.
  const applied = useRef<{ doc: SceneDoc; text: string } | null>(null);
  const generated = useRef<{ doc: SceneDoc; text: string } | null>(null);
  const edited = generated.current !== null && text !== generated.current.text && text !== applied.current?.text;
  const runFailed = status.kind === 'ok' && !edited && !!error; // the code reads fine, but running the scene fails

  // Show the document's code: when it changes elsewhere, and after typing here (then on leaving the editor, so the
  // text isn't rewritten under the cursor).
  const regenerate = () => {
    const before = taRef.current?.value ?? '';
    const d = getState().doc;
    api.code(d).then((r) => {
      if ((taRef.current?.value ?? '') !== before) return; // typed meanwhile: that wins
      if (before && before !== generated.current?.text && before !== applied.current?.text) toast('The scene changed, so the code edits that weren’t applied were replaced');
      generated.current = { doc: d, text: r.code };
      applied.current = null;
      setLinemap(r.linemap);
      setSpans(r.spans ?? {});
      setText(r.code);
      setStatus((st) => (st.kind === 'error' || st.kind === 'pending' ? { kind: 'ok', message: '' } : st));
    }).catch((e) => toast(String(e)));
  };
  useEffect(() => {
    if (applied.current?.doc === doc) return;
    const t = setTimeout(regenerate, 60);
    return () => clearTimeout(t);
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing: read the code into the scene after a pause.
  useEffect(() => {
    if (!live || !edited) return;
    setStatus({ kind: 'pending', message: 'Reading the code…' });
    const t = setTimeout(() => void apply(text), 650);
    return () => clearTimeout(t);
  }, [text, live]); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply(code: string) {
    const base = getState().doc;
    try {
      const res = await api.importCode(code, base, base.scene.name);
      if (taRef.current && taRef.current.value !== code) return; // typed on meanwhile; the next pause applies that
      if (!res.ok) return setStatus({ kind: 'error', message: res.error, line: res.line });
      updateDoc((d) => {
        for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
        Object.assign(d, res.doc);
      }, 'code-edit');
      applied.current = { doc: getState().doc, text: code };
      setStatus({ kind: 'ok', message: 'Applied', notes: res.notes });
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) });
    }
  }

  // Where an element's code is: its own span, else the statement it is part of (an animation in a play kept as one).
  const spansOf = (id: string): CodeSpan[] => {
    if (spans[id]) return spans[id];
    const r = findAnim(doc, id);
    return r ? spansOf(r.parent?.id ?? r.step.id) : Object.entries(linemap).filter(([, x]) => x[1] === id).map(([l]) => [Number(l), 0, Number(l), Infinity]);
  };
  const linesOf = (list: CodeSpan[]) => new Set(list.flatMap(([l, , el]) => Array.from({ length: el - l + 1 }, (_, i) => l + i)));
  const refLines = (kind: string | null, id: string | null) => (!kind || !id ? new Set<number>() : linesOf(spansOf(id)));
  // What is selected: objects and clips (steps, animations); a marker stands for what it is attached to.
  const selIds = selection?.kind === 'object' ? [selection.id] : selection?.kind === 'objects' ? selection.ids : selection?.kind === 'clips' ? selection.ids
    : selection?.kind === 'marker' ? [doc.markers?.find((m) => m.id === selection.id)?.anchor?.id].filter((x): x is string => !!x) : [];
  const { selLines, marks, relLines } = useMemo(() => {
    const none = { selLines: new Set<number>(), marks: new Map<number, [number, number][]>(), relLines: new Set<number>() };
    if (edited) return none;
    // the block: an animation's whole statement (its self.play), anything else its own code
    const own = selIds.flatMap((id) => spansOf(findAnim(doc, id)?.step.id ?? id));
    // the exact code of each selected animation, part by part of its lines
    const marks = new Map<number, [number, number][]>();
    for (const id of selIds) {
      if (!spans[id] || !findAnim(doc, id)) continue;
      for (const [l, c, el, ec] of spans[id]) {
        for (let n = l; n <= el; n++) {
          const ln = lines[n - 1] ?? '';
          const from = n === l ? c : ln.length - ln.trimStart().length;
          marks.set(n, [...(marks.get(n) ?? []), [from, (n === el ? ec : ln.length) - from]]);
        }
      }
    }
    // the objects the selected clips animate or change: where they are made
    const targets = new Set(selIds.flatMap((id) => {
      const a = findAnim(doc, id)?.anim;
      const step = doc.timeline.find((s) => s.id === id);
      const t = a?.target ?? (step?.kind === 'apply' ? step.target : undefined) ?? '';
      return t.split(',').map((x) => rootName(x.trim())).filter(Boolean);
    }));
    const rel = doc.objects.filter((o) => targets.has(o.name)).flatMap((o) => spansOf(o.id));
    const selLines = linesOf(own);
    return { selLines, marks, relLines: new Set([...linesOf(rel)].filter((n) => !selLines.has(n))) };
  }, [spans, linemap, doc, selIds.join(','), edited, text]); // eslint-disable-line react-hooks/exhaustive-deps
  const errLines = useMemo(() => {
    if (status.kind === 'error' && status.line) return new Set([status.line]);
    return edited || !error ? new Set<number>() : refLines(error.kind, error.id);
  }, [linemap, spans, error, status, edited]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the selection into view (when the selection comes from elsewhere).
  useEffect(() => {
    const first = Math.min(...selLines);
    const last = Math.max(...selLines);
    const ta = taRef.current;
    if (!ta || !Number.isFinite(first) || ta === document.activeElement) return;
    const lh = lineHeight(ta);
    const y = (first - 1) * lh;
    const end = last * lh;
    // the whole block in view (its top, when it is taller than the editor)
    if (y < ta.scrollTop || end > ta.scrollTop + ta.clientHeight - lh) ta.scrollTop = Math.max(0, Math.min(y - lh * 2, end - ta.clientHeight + lh * 2));
  }, [selLines]);

  // Clicking a line selects what it is (an object, a statement, an animation).
  const pickAtCaret = () => {
    const ta = taRef.current;
    if (!ta || edited || ta.selectionStart !== ta.selectionEnd) return;
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    const line = before.length;
    const col = before[line - 1].length;
    // the innermost animation under the caret (one of several in a self.play, or inside a group)
    const inside = ([l, c, el, ec]: CodeSpan) => (line > l || (line === l && col >= c)) && (line < el || (line === el && col <= ec));
    const size = ([l, c, el, ec]: CodeSpan) => (el - l) * 1e4 + ec - c;
    const hit = Object.entries(spans).filter(([id, list]) => findAnim(doc, id) && list.some(inside))
      .sort(([, a], [, b]) => size(a[0]) - size(b[0]))[0];
    if (hit) return void selectClips([hit[0]]);
    const ref = linemap[String(line)];
    if (!ref) return;
    if (ref[0] === 'object') selectObjects([ref[1]]);
    else if (ref[0] === 'step' || ref[0] === 'anim') selectClips([ref[1]]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void apply(e.currentTarget.value);
      return;
    }
    codeKeys(e, setText);
  };

  const syncScroll = () => {
    const ta = taRef.current!;
    if (backRef.current) {
      backRef.current.scrollTop = ta.scrollTop;
      backRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };
  useLayoutEffect(syncScroll, [text]);

  const highlighted = useMemo(() => lines.map(highlight), [text]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="monitor code-monitor">
      <div className="monitor-title">
        <button className="ghost small tab-btn" onClick={() => setState({ centerTab: 'program' })} title="Back to the canvas">Program</button>
        <span className="tab-btn on">Code: {doc.scene.name}.py</span>
        <span className="spacer" />
        <span className={`code-status ${runFailed ? 'error' : status.kind}`} title={runFailed ? error!.message : status.message}>
          {status.kind === 'pending' ? 'Reading…' : status.kind === 'error' ? `⚠ ${status.message}` : runFailed ? `⚠ ${error!.message}` : edited ? 'Edited' : 'In sync with the timeline'}
        </span>
        <label className="toggle" title="Read the code into the scene as you type (after a short pause)"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live</label>
        {!live && <button className="primary small" disabled={!edited} onClick={() => void apply(text)} title={`Read the code into the scene (${keys('⌘')}Enter)`}>Apply</button>}
        <button className="ghost small" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied'))}>Copy</button>
        <button className="ghost small" title="Open a manim .py file as a new project" onClick={() => void importManimFile().catch((e) => toast(String(e)))}>Open .py…</button>
        <button className="ghost small" onClick={async () => {
          const p = await askPath('save', `${doc.scene.name}.py`, ['Python (*.py)'], 'Save .py to path:');
          if (p) toast(`Saved ${(await api.exportCode(getState().doc, p)).path}`);
        }}>Save .py</button>
      </div>
      <div className="code-wrap">
        <div className="code-gutter" ref={gutterRef} aria-hidden>
          {lines.map((_, i) => <div key={i} className={`${selLines.has(i + 1) ? 'sel' : ''} ${errLines.has(i + 1) ? 'err' : ''}`}>{i + 1}</div>)}
        </div>
        <div className="code-area">
          <div className="code-back" ref={backRef} aria-hidden>
            <div className="code-lines">
              {highlighted.map((html, i) => (
                <div key={i} className={`code-ln ${blockClass(selLines, i + 1, 'sel')} ${blockClass(relLines, i + 1, 'rel')} ${errLines.has(i + 1) ? 'err' : ''}`}>
                  <span dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                  {marks.get(i + 1)?.map(([c, n], k) => <i key={k} className="code-mark" style={{ left: `calc(var(--code-pad) + ${c}ch)`, width: `${n}ch` }} />)}
                </div>
              ))}
            </div>
          </div>
          <textarea
            ref={taRef}
            className="code-text"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            value={text}
            placeholder={'Paste a manim scene here, e.g.\n\nfrom manim import *\n\nclass MyScene(Scene):\n    def construct(self):\n        c = Circle()\n        self.play(Create(c))'}
            onChange={(e) => setText(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            onClick={pickAtCaret}
            onKeyUp={(e) => e.key.startsWith('Arrow') && pickAtCaret()}
            onBlur={() => {
              if (applied.current?.doc === getState().doc && taRef.current?.value === applied.current.text) regenerate();
            }}
          />
        </div>
        {image && (
          <button className="code-pip" title="The frame at the playhead: click for the canvas" onClick={() => setState({ centerTab: 'program' })}>
            <img src={image} alt="" />
          </button>
        )}
      </div>
      {(status.notes?.length ?? 0) > 0 && !edited && (
        <div className="code-notes">
          {status.notes!.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}
    </div>
  );
}

/** A highlighted line's place in its block (the lines highlighted together): one box around the block. */
function blockClass(set: Set<number>, n: number, name: string): string {
  if (!set.has(n)) return '';
  return `${name}${set.has(n - 1) ? '' : ` ${name}-top`}${set.has(n + 1) ? '' : ` ${name}-bottom`}`;
}

function lineHeight(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).lineHeight) || 19;
}
