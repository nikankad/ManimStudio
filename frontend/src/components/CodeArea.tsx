import { useMemo, useRef } from 'react';

/** Tab indents (Shift+Tab outdents), Enter keeps the indentation (one more level after a colon). */
export function codeKeys(e: React.KeyboardEvent<HTMLTextAreaElement>, setText: (v: string) => void) {
  const ta = e.currentTarget;
  const insert = (s: string) => {
    // execCommand keeps the browser's own undo history
    if (!document.execCommand('insertText', false, s)) {
      ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, 'end');
      setText(ta.value);
    }
  };
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = ta;
    if (a === b && !e.shiftKey) return insert('    ');
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const block = value.slice(start, b);
    const next = e.shiftKey ? block.replace(/^ {1,4}/gm, '') : block.replace(/^/gm, '    ');
    ta.setSelectionRange(start, b);
    insert(next);
    ta.setSelectionRange(start, start + next.length);
  } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const { selectionStart: a, value } = ta;
    const line = value.slice(value.lastIndexOf('\n', a - 1) + 1, a);
    insert('\n' + line.match(/^\s*/)![0] + (/:\s*(#.*)?$/.test(line) ? '    ' : ''));
  }
}

/** A small Python editor with highlighting, sized to its code (code steps, Python arguments). */
export function CodeArea({ value, onChange, minLines = 3, placeholder }: { value: string; onChange: (v: string) => void; minLines?: number; placeholder?: string }) {
  const lines = value.split('\n');
  const html = useMemo(() => lines.map(highlight), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const back = useRef<HTMLDivElement>(null);
  const rows = Math.max(minLines, lines.length);
  return (
    <div className="code-area-small" style={{ height: rows * 18 + 14 }}>
      <div className="code-back" ref={back} aria-hidden>
        <div className="code-lines">{html.map((h, i) => <div key={i} className="code-ln" dangerouslySetInnerHTML={{ __html: h || ' ' }} />)}</div>
      </div>
      <textarea className="code-text" spellCheck={false} wrap="off" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => codeKeys(e, onChange)}
        onScroll={(e) => back.current && (back.current.scrollLeft = e.currentTarget.scrollLeft)} />
    </div>
  );
}

// ---------------------------------------------------------------- Python highlighting (one line at a time)

const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const LITERALS = new Set(['True', 'False', 'None']);
const OPERATOR = /^[=+\-*/%<>!&|^~@]$/;
const TOKEN = /(#.*$)|([rRbBuUfF]{0,2}"""[\s\S]*?(?:"""|$)|[rRbBuUfF]{0,2}'''[\s\S]*?(?:'''|$)|[rRbBuUfF]{0,2}"(?:\\.|[^"\\])*"?|[rRbBuUfF]{0,2}'(?:\\.|[^'\\])*'?)|(\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([A-Za-z_]\w*)(\s*\()?|(\S)/g;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line of Python as HTML with token classes (t-kw, t-str…). */
export function highlight(line: string): string {
  let out = '';
  let last = 0;
  let prev = '';
  for (const m of line.matchAll(TOKEN)) {
    out += esc(line.slice(last, m.index));
    last = m.index! + m[0].length;
    const [all, comment, str, num, word, call] = m;
    if (comment) out += `<span class="t-com">${esc(comment)}</span>`;
    else if (str) out += `<span class="t-str">${esc(str)}</span>`;
    else if (num) out += `<span class="t-num">${num}</span>`;
    else if (word) {
      const cls = LITERALS.has(word) ? 't-lit' : KEYWORDS.has(word) ? 't-kw' : word === 'self' ? 't-self' : prev === 'def' || prev === 'class' ? 't-def'
        : /^[A-Z][A-Z0-9_]+$/.test(word) ? 't-const' : call ? (/^[A-Z]/.test(word) ? 't-cls' : 't-fn') : /^[A-Z]/.test(word) ? 't-cls' : '';
      out += cls ? `<span class="${cls}">${word}</span>` : word;
      if (call) out += esc(call);
      prev = word;
      continue;
    } else out += OPERATOR.test(all) ? `<span class="t-op">${esc(all)}</span>` : esc(all);
    prev = '';
  }
  return out + esc(line.slice(last));
}
