import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, askPath, type LineKind } from '../api';
import { getState, selectClips, selectObjects, setState, toast, updateDoc, useStore } from '../store';
import type { SceneDoc } from '../types';
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
  const [status, setStatus] = useState<{ kind: 'ok' | 'pending' | 'error'; message: string; line?: number | null; notes?: string[] }>({ kind: 'ok', message: '' });
  const [live, setLive] = useState(true);
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

  // Lines of the selected element (and of the element with an error).
  const refLines = (kind: string | null, id: string | null) =>
    !kind || !id ? new Set<number>() : new Set(Object.entries(linemap).filter(([, r]) => r[1] === id && (r[0] === kind || (kind === 'step' && r[0] === 'anim') || (kind === 'anim' && r[0] === 'step'))).map(([l]) => Number(l)));
  const selIds = selection?.kind === 'object' ? [selection.id] : selection?.kind === 'objects' ? selection.ids : selection?.kind === 'clips' ? selection.ids : [];
  const selLines = useMemo(() => {
    if (edited) return new Set<number>();
    const ids = new Set(selIds);
    return new Set(Object.entries(linemap).filter(([, r]) => ids.has(r[1])).map(([l]) => Number(l)));
  }, [linemap, selIds.join(','), edited]); // eslint-disable-line react-hooks/exhaustive-deps
  const errLines = useMemo(() => {
    if (status.kind === 'error' && status.line) return new Set([status.line]);
    return edited || !error ? new Set<number>() : refLines(error.kind, error.id);
  }, [linemap, error, status, edited]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the selection into view (when the selection comes from elsewhere).
  useEffect(() => {
    const first = Math.min(...selLines);
    const ta = taRef.current;
    if (!ta || !Number.isFinite(first) || ta === document.activeElement) return;
    const lh = lineHeight(ta);
    const y = (first - 1) * lh;
    if (y < ta.scrollTop || y > ta.scrollTop + ta.clientHeight - lh * 3) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  }, [selLines]);

  // Clicking a line selects what it is (an object, a statement, an animation).
  const pickAtCaret = () => {
    const ta = taRef.current;
    if (!ta || edited || ta.selectionStart !== ta.selectionEnd) return;
    const line = ta.value.slice(0, ta.selectionStart).split('\n').length;
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

  const lines = text.split('\n');
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
                <div key={i} className={`code-ln ${selLines.has(i + 1) ? 'sel' : ''} ${errLines.has(i + 1) ? 'err' : ''}`} dangerouslySetInnerHTML={{ __html: html || ' ' }} />
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

function lineHeight(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).lineHeight) || 19;
}
