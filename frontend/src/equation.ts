// Equations as terms: splitting LaTeX into parts and keeping term identities across edits.
//
// Each part becomes one argument of MathTex(...), so manim isolates it as one submobject
// (eq[i]). Parts are positional, so repeated symbols are distinct occurrences.

const uid = (p: string) => p + Math.random().toString(36).slice(2, 9);
import type { EqPart } from './types';

// Commands and how many {…} arguments they take (others: 0).
const ARGS: Record<string, number> = {
  frac: 2, dfrac: 2, tfrac: 2, binom: 2, sqrt: 1, text: 1, mathrm: 1, mathbf: 1, mathit: 1, mathcal: 1, mathbb: 1, operatorname: 1,
  hat: 1, bar: 1, vec: 1, dot: 1, ddot: 1, tilde: 1, overline: 1, underline: 1, widehat: 1, overrightarrow: 1, boxed: 1,
  color: 1, textcolor: 2, overbrace: 1, underbrace: 1, mathfrak: 1, pmb: 1, boldsymbol: 1, cancel: 1, stackrel: 2, overset: 2, underset: 2,
};

function group(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') {
      j++;
      continue;
    }
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return j + 1;
  }
  return src.length;
}

/** Split LaTeX into top-level terms: symbols, numbers, operators, commands with their arguments, groups. Scripts stay with their base. */
export function splitTerms(latex: string): string[] {
  const src = latex.trim();
  const out: string[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  while (i < src.length) {
    skipWs();
    if (i >= src.length) break;
    const start = i;
    const ch = src[i];
    if (ch === '\\') {
      const m = src.slice(i).match(/^\\([A-Za-z]+|.)/)!;
      const name = m[1];
      i += m[0].length;
      if (name === 'begin') {
        const env = src.slice(i).match(/^\{([^}]*)\}/)?.[1] ?? '';
        const end = src.indexOf(`\\end{${env}}`, i);
        i = end < 0 ? src.length : end + `\\end{${env}}`.length;
      } else if (name === 'left') {
        let depth = 1;
        while (i < src.length && depth) {
          const k = src.slice(i).match(/^\\(left|right)\b/);
          if (k) {
            depth += k[1] === 'left' ? 1 : -1;
            i += k[0].length;
          } else i++;
        }
        i = Math.min(src.length, i + (src[i] === '\\' ? 2 : 1)); // the delimiter after \right
      } else {
        skipWs();
        if (src[i] === '[' && name === 'sqrt') i = group(src, i, '[', ']');
        for (let k = 0; k < (ARGS[name] ?? 0); k++) {
          skipWs();
          if (src[i] === '{') i = group(src, i, '{', '}');
          else if (i < src.length) i += src[i] === '\\' ? (src.slice(i).match(/^\\([A-Za-z]+|.)/)?.[0].length ?? 1) : 1;
        }
      }
    } else if (ch === '{') {
      i = group(src, i, '{', '}');
    } else if (/[0-9.]/.test(ch)) {
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
    } else {
      i++;
    }
    // Attach ^ and _ scripts (and primes) to their base.
    for (;;) {
      const save = i;
      skipWs();
      if (src[i] === "'") {
        i++;
        continue;
      }
      if (src[i] === '^' || src[i] === '_') {
        i++;
        skipWs();
        if (src[i] === '{') i = group(src, i, '{', '}');
        else if (src[i] === '\\') i += src.slice(i).match(/^\\([A-Za-z]+|.)/)?.[0].length ?? 1;
        else i++;
        continue;
      }
      i = save;
      break;
    }
    const term = src.slice(start, i).trim();
    if (term) out.push(term);
  }
  return out;
}

/**
 * Merge a new list of term texts with the old parts, keeping term identities: unchanged terms keep
 * their id and color (longest common subsequence); within each changed run, edited terms are paired
 * with the old ones by position (so retyping "x" as "y" keeps its styling and correspondences).
 */
export function mergeTerms(old: EqPart[], texts: string[]): EqPart[] {
  const n = old.length, m = texts.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) L[a][b] = old[a].tex === texts[b] ? L[a + 1][b + 1] + 1 : Math.max(L[a + 1][b], L[a][b + 1]);
  const out: EqPart[] = [];
  let dels: EqPart[] = [];
  let ins: string[] = [];
  const flush = () => {
    ins.forEach((tex, k) => out.push(k < dels.length ? { ...dels[k], tex } : { id: uid('p'), tex }));
    dels = [];
    ins = [];
  };
  let a = 0, b = 0;
  while (a < n || b < m) {
    if (a < n && b < m && old[a].tex === texts[b]) {
      flush();
      out.push({ ...old[a++] });
      b++;
    } else if (b >= m || (a < n && L[a + 1][b] >= L[a][b + 1])) dels.push(old[a++]);
    else ins.push(texts[b++]);
  }
  flush();
  return out;
}

export const joinTerms = (parts: EqPart[]) => parts.map((p) => p.tex).join(' ');

/** Display label for a term: "x" or "x #2" when the same text occurs more than once. */
export function termLabel(parts: EqPart[], i: number): string {
  const same = parts.filter((p) => p.tex === parts[i].tex);
  if (same.length < 2) return parts[i].tex;
  return `${parts[i].tex} #${same.indexOf(parts[i]) + 1}`;
}

/** Pair identical terms in order of occurrence (a starting point; it doesn't check the math). */
export function autoPairs(src: EqPart[], dst: EqPart[]): [string, string][] {
  const used = new Set<string>();
  const out: [string, string][] = [];
  for (const s of src) {
    const t = dst.find((d) => d.tex === s.tex && !used.has(d.id));
    if (t) {
      used.add(t.id);
      out.push([s.id, t.id]);
    }
  }
  return out;
}

/** MathLive output → LaTeX that real LaTeX (MathTex) accepts. */
export function normalizeLatex(src: string): string {
  return src
    .replace(/\\mleft/g, '\\left')
    .replace(/\\mright/g, '\\right')
    .replace(/\\exponentialE/g, 'e')
    .replace(/\\imaginaryI/g, 'i')
    .replace(/\\differentialD/g, 'd')
    .replace(/\\placeholder(\[[^\]]*\])?\{[^}]*\}/g, '')
    .trim();
}

