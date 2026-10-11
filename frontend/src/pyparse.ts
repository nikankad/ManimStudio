// Tiny helpers for reading/writing the Python source strings stored in the scene document,
// so structured GUI fields (lists, dicts, vectors, method chains) can round-trip them.

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Split at top-level occurrences of `sep`, ignoring brackets and string literals. */
export function splitTop(src: string, sep = ','): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += src[++i] ?? '';
      else if (src.startsWith(quote, i)) {
        cur += quote.slice(1);
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      cur += quote;
      i += quote.length - 1;
      continue;
    }
    if (OPEN[ch]) stack.push(OPEN[ch]);
    else if (ch === stack[stack.length - 1]) stack.pop();
    if (ch === sep && stack.length === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out.filter((x, i, a) => x !== '' || i < a.length - 1);
}

/** Index of the bracket closing the one at `start`, or -1. */
function closing(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (OPEN[ch]) depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `[a, b]`, `(a, b)` or `np.array([a, b])` -> items; anything else -> null. */
export function parseList(src: string): string[] | null {
  let s = src.trim();
  const np = s.match(/^np\.array\(([\s\S]*)\)$/);
  if (np) s = np[1].trim();
  if (!s) return null;
  if (!((s[0] === '[' || s[0] === '(') && closing(s, 0) === s.length - 1)) return null;
  return splitTop(s.slice(1, -1));
}

/** `{k: v, ...}` or `dict(k=v, ...)` -> [key source, value source][]; else null. */
export function parseDict(src: string): [string, string][] | null {
  const s = src.trim();
  if (!s) return [];
  if (s.startsWith('dict(') && closing(s, 4) === s.length - 1) {
    const out: [string, string][] = [];
    for (const item of splitTop(s.slice(5, -1))) {
      const m = item.match(/^(\w+)\s*=([\s\S]*)$/);
      if (!m) return null;
      out.push([JSON.stringify(m[1]), m[2].trim()]);
    }
    return out;
  }
  if (s[0] !== '{' || closing(s, 0) !== s.length - 1) return null;
  const out: [string, string][] = [];
  for (const item of splitTop(s.slice(1, -1))) {
    const kv = splitTop(item, ':');
    if (kv.length < 2) return null;
    out.push([kv[0], kv.slice(1).join(':').trim()]);
  }
  return out;
}

export const formatDict = (items: [string, string][]) => (items.length ? `{${items.map(([k, v]) => `${k}: ${v}`).join(', ')}}` : '');

/** Python string literal -> its text, or null if `src` isn't a plain literal. */
export function pyString(src: string): string | null {
  const m = src.trim().match(/^([rR]?)("""|'''|"|')([\s\S]*)\2$/);
  if (!m) return null;
  if (m[1]) return m[3];
  if (!m[3].includes('\\')) return m[3];
  try {
    return m[2] === '"' ? JSON.parse(`"${m[3]}"`) : null;
  } catch {
    return null;
  }
}

/** Text -> Python string literal. */
export function pyQuote(text: string): string {
  if (text.endsWith('\\')) return JSON.stringify(text);
  if (text.includes('\n') || text.includes('"')) return text.includes('"""') ? JSON.stringify(text) : `r"""${text}"""`;
  return text.includes('\\') ? `r"${text}"` : `"${text}"`;
}

export interface Call {
  name: string;
  args: string; // source between the parentheses
}

/** `.a(x).b(y=1)` (newlines allowed) -> calls; null if it's anything fancier. */
export function parseChain(src: string): Call[] | null {
  const calls: Call[] = [];
  let i = 0;
  const s = src;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const m = s.slice(i).match(/^\.([A-Za-z_]\w*)\s*\(/);
    if (!m) return null;
    const open = i + m[0].length - 1;
    const close = closing(s, open);
    if (close < 0) return null;
    calls.push({ name: m[1], args: s.slice(open + 1, close).trim() });
    i = close + 1;
  }
  return calls;
}

export const formatChain = (calls: Call[]) => calls.map((c) => `.${c.name}(${c.args})`).join('\n');

/** Call argument source -> positional list + keyword map (in order). */
export function parseArgs(src: string): { pos: string[]; kw: [string, string][] } {
  const pos: string[] = [];
  const kw: [string, string][] = [];
  for (const part of splitTop(src)) {
    if (!part) continue;
    const m = part.match(/^([A-Za-z_]\w*)\s*=(?!=)([\s\S]*)$/);
    if (m) kw.push([m[1], m[2].trim()]);
    else pos.push(part);
  }
  return { pos, kw };
}

// ---------------------------------------------------------------- numeric evaluation

type V = number | number[];
const DIRS: Record<string, number[]> = {
  UP: [0, 1, 0], DOWN: [0, -1, 0], LEFT: [-1, 0, 0], RIGHT: [1, 0, 0], ORIGIN: [0, 0, 0], IN: [0, 0, -1], OUT: [0, 0, 1],
  UL: [-1, 1, 0], UR: [1, 1, 0], DL: [-1, -1, 0], DR: [1, -1, 0], X_AXIS: [1, 0, 0], Y_AXIS: [0, 1, 0], Z_AXIS: [0, 0, 1],
};
const CONSTS: Record<string, number> = { PI: Math.PI, TAU: 2 * Math.PI, DEGREES: Math.PI / 180, E: Math.E };

function op(a: V, b: V, f: (x: number, y: number) => number): V {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  const n = Math.max(typeof a === 'number' ? 0 : a.length, typeof b === 'number' ? 0 : b.length);
  return Array.from({ length: n }, (_, i) => f(typeof a === 'number' ? a : a[i] ?? 0, typeof b === 'number' ? b : b[i] ?? 0));
}

/** Evaluate simple numeric/vector expressions (`PI / 3`, `UP * 2 + LEFT`, `[1, -2, 0]`); null if unsupported. */
export function evalPy(src: string): V | null {
  const toks = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_][\w.]*|\*\*|[-+*/()[\],]/gi);
  if (!toks || toks.join('') !== src.replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => toks[i];
  const expr = (): V => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const o = toks[i++];
      const r = term();
      v = op(v, r, o === '+' ? (x, y) => x + y : (x, y) => x - y);
    }
    return v;
  };
  const term = (): V => {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const o = toks[i++];
      const r = unary();
      v = op(v, r, o === '*' ? (x, y) => x * y : (x, y) => x / y);
    }
    return v;
  };
  const unary = (): V => {
    if (peek() === '-') {
      i++;
      return op(unary(), -1, (x, y) => x * y);
    }
    if (peek() === '+') {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): V => {
    const b = atom();
    if (peek() === '**') {
      i++;
      const e = unary();
      return op(b, e, (x, y) => x ** y);
    }
    return b;
  };
  const atom = (): V => {
    const t = toks[i++];
    if (t === undefined) throw new Error('eof');
    if (t === '(' || t === '[') {
      const items: V[] = [expr()];
      while (peek() === ',') {
        i++;
        if (peek() === ')' || peek() === ']') break;
        items.push(expr());
      }
      if (toks[i++] !== (t === '(' ? ')' : ']')) throw new Error('bracket');
      if (t === '(' && items.length === 1) return items[0];
      if (items.some((x) => typeof x !== 'number')) throw new Error('nested');
      return items as number[];
    }
    if (t === 'np.array') {
      if (toks[i++] !== '(') throw new Error('call');
      const v = expr();
      if (toks[i++] !== ')') throw new Error('call');
      return v;
    }
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t in CONSTS) return CONSTS[t];
    if (t in DIRS) return [...DIRS[t]];
    throw new Error('name ' + t);
  };
  try {
    const v = expr();
    return i === toks.length ? v : null;
  } catch {
    return null;
  }
}

export function evalNumber(src: string): number | null {
  const v = evalPy(src);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function evalVector(src: string): number[] | null {
  const v = evalPy(src);
  return Array.isArray(v) && v.every(Number.isFinite) ? v : null;
}

export const fmtNum = (v: number, precision = 3) => String(Math.round(v * 10 ** precision) / 10 ** precision);

const DIR_NAMES = Object.entries(DIRS).filter(([k]) => !k.includes('_'));
/** Vector -> nicest source: a direction constant, `UP * 2`, or `[x, y, z]`. */
export function formatVector(v: number[], precision = 3): string {
  const r = v.map((x) => Math.round(x * 10 ** precision) / 10 ** precision);
  while (r.length < 3) r.push(0);
  for (const [name, d] of DIR_NAMES) if (d.every((x, i) => x === r[i])) return name;
  for (const [name, d] of DIR_NAMES) {
    const k = d.reduce((acc, x, i) => (x ? r[i] / x : acc), NaN);
    if (Number.isFinite(k) && k > 0 && d.every((x, i) => Math.abs(x * k - r[i]) < 1e-9)) return `${name} * ${fmtNum(k, precision)}`;
  }
  return `np.array([${r.map((x) => fmtNum(x, precision)).join(', ')}])`;
}
