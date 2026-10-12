// JS versions of manim's rate functions, used to draw a curve until manim has measured the real one.

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const smooth = (t: number) => {
  const err = sigmoid(-5);
  return Math.min(1, Math.max(0, (sigmoid(10 * (t - 0.5)) - err) / (1 - 2 * err)));
};

const base: Record<string, (t: number) => number> = {
  linear: (t) => t,
  smooth,
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (6 * t - 15) + 10),
  rush_into: (t) => 2 * smooth(t / 2),
  rush_from: (t) => 2 * smooth(t / 2 + 0.5) - 1,
  slow_into: (t) => Math.sqrt(1 - (1 - t) * (1 - t)),
  double_smooth: (t) => (t < 0.5 ? 0.5 * smooth(2 * t) : 0.5 * (1 + smooth(2 * t - 1))),
  there_and_back: (t) => smooth(t < 0.5 ? 2 * t : 2 * (1 - t)),
  there_and_back_with_pause: (t) => (t < 1 / 3 ? smooth(3 * t) : t < 2 / 3 ? 1 : smooth(3 - 3 * t)),
  running_start: (t) => {
    const p = [0, 0, -0.5, -0.5, 1, 1, 1];
    // Bezier with control points as in manim
    const n = p.length - 1;
    let r = 0;
    for (let k = 0; k <= n; k++) r += binom(n, k) * Math.pow(1 - t, n - k) * Math.pow(t, k) * p[k];
    return r;
  },
  wiggle: (t) => there_and_back(t) * Math.sin(4 * Math.PI * t) * 0.5 + 0.5,
  lingering: (t) => Math.min(1, t / 0.8),
  exponential_decay: (t) => 1 - Math.exp(-t / 0.1),
};
function there_and_back(t: number) {
  return smooth(t < 0.5 ? 2 * t : 2 * (1 - t));
}
function binom(n: number, k: number) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const easeIn: Record<string, (t: number) => number> = {
  sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  quad: (t) => t * t,
  cubic: (t) => t ** 3,
  quart: (t) => t ** 4,
  quint: (t) => t ** 5,
  expo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  circ: (t) => 1 - Math.sqrt(1 - t * t),
  back: (t) => 2.70158 * t ** 3 - 1.70158 * t * t,
  elastic: (t) => (t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  bounce: (t) => 1 - bounceOut(1 - t),
};
function bounceOut(t: number) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export function rateFn(name: string | undefined): (t: number) => number {
  const n = (name || 'smooth').trim().replace(/^rate_functions\./, '');
  if (base[n]) return base[n];
  const m = n.match(/^ease_(in_out|in|out)_(\w+)$/);
  if (m && easeIn[m[2]]) {
    const f = easeIn[m[2]];
    if (m[1] === 'in') return f;
    if (m[1] === 'out') return (t) => 1 - f(1 - t);
    return (t) => (t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2);
  }
  return smooth;
}

/** Progress sampled at evenly spaced times, as a function. */
function sampled(curve: number[]): (t: number) => number {
  const n = curve.length - 1;
  return (t) => {
    const x = Math.max(0, Math.min(1, t)) * n, i = Math.min(n - 1, Math.floor(x));
    return curve[i] + (curve[i + 1] - curve[i]) * (x - i);
  };
}

/** SVG path of the curve over a w×h box (y up): a rate function's name, or progress samples measured by manim. */
export function ratePath(rate: string | number[] | undefined, w: number, h: number): string {
  const f = Array.isArray(rate) ? (rate.length > 1 ? sampled(rate) : rateFn('linear')) : rateFn(rate);
  const n = Math.max(8, Math.min(64, Math.round(w / 4)));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = Math.max(-0.3, Math.min(1.3, f(t)));
    d += `${i ? 'L' : 'M'}${(t * w).toFixed(1)},${(h - y * h).toFixed(1)}`;
  }
  return d;
}
