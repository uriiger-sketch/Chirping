// Statistics shared by the synthetic and the real-recording benchmarks (rules:
// .claude/skills/classifier-statistics). Rows carry `si` (species index) for the bootstrap,
// `pTop`/`topIsTrue` for calibration.

const bySpecies = (rows, f) => { const m = new Map(); for (const r of rows) { if (!m.has(r.si)) m.set(r.si, []); m.get(r.si).push(f(r)); } return [...m.values()]; };

// Mean of f(row) with a 95 % CI from a bootstrap that resamples SPECIES (rows of one species are
// correlated), plus the naive binomial SE used for the monotonicity check.
export function metric(rows, f, B = 2000) {
  const groups = bySpecies(rows, f), flat = groups.flat(), mean = flat.reduce((s, v) => s + v, 0) / (flat.length || 1);
  let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, boots = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(rnd() * groups.length)]; for (const v of g) { s += v; n++; } } boots.push(s / (n || 1)); }
  boots.sort((x, y) => x - y);
  return { mean, lo: boots[Math.floor(0.025 * B)], hi: boots[Math.floor(0.975 * B) - 1], se: Math.sqrt(mean * (1 - mean) / (flat.length || 1)), n: flat.length };
}

const erfc = x => { const t = 1 / (1 + 0.5 * Math.abs(x)), y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? y : 2 - y; };

// McNemar with continuity correction on paired outcomes a(row), b(row).
export function mcnemar(rows, a, b) {
  let n10 = 0, n01 = 0; for (const r of rows) { const x = a(r), y = b(r); if (x && !y) n10++; else if (!x && y) n01++; }
  const chi = n10 + n01 ? (Math.abs(n10 - n01) - 1) ** 2 / (n10 + n01) : 0;
  return { aOnly: n10, bOnly: n01, p: erfc(Math.sqrt(chi / 2)) };
}

// Expected calibration error (10 equal-width bins of the top-1 probability), Brier score, bins.
export function calibration(rows) {
  const bins = Array.from({ length: 10 }, () => [0, 0, 0]); let brier = 0;
  for (const r of rows) { const k = Math.min(9, Math.floor(r.pTop * 10)); bins[k][0]++; bins[k][1] += r.pTop; bins[k][2] += r.topIsTrue ? 1 : 0; brier += (r.pTop - (r.topIsTrue ? 1 : 0)) ** 2; }
  return { ece: bins.reduce((s, [, p, h]) => s + Math.abs(p - h), 0) / (rows.length || 1), brier: brier / (rows.length || 1), bins };
}
export const reliability = bins => bins.map(([n, p, h]) => n ? `${(p / n).toFixed(2)}→${(h / n).toFixed(2)}` : '·').join(' ');
export const pct = m => `${(m.mean * 100).toFixed(1)}% [${(m.lo * 100).toFixed(1)}–${(m.hi * 100).toFixed(1)}]`;
