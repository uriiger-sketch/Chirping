// Fit Chirping's interpretable model to REAL recordings (data/xc-features.jsonl) — no browser, no
// network, deterministic. Rules: .claude/skills/classifier-statistics ("Fitting on real audio").
//
//   node tools/fit-model.mjs [--features data/xc-features.jsonl] [--write] [--html index.html] [--prov docs/bird-db-provenance.json]
//
// 1. Recordist-disjoint split (tests/lib/real-data.mjs): only TRAIN recordings are used here;
//    tests/real-benchmark.mjs scores the held-out ones.
// 2. Per species, empirical-Bayes shrinkage of the expert catalogue value (prior width from its
//    confidence cf: h/m/l → σ 0.08/0.15/0.30 in ln f) toward robust statistics of the measured
//    windows (median, MAD, quantiles; every recording weighs the same):
//    fdom, fmin/fmax (10th pct of F5, 90th of F95), the species' own pitch spread, its texture
//    (logit c1, logit c3, ln IQR) shrunk toward its type prototype, note-rate range and the
//    probability that a rate is detected at all. Fewer than --min-train recordings → untouched.
// 3. Global multipliers (spScale, tsScale, outlier) by 3-fold recordist-grouped cross-validation
//    inside the training split, then the likelihood temperature by NLL.
// 4. --write: rewrites the BIRD_DB entries and MODEL constants in index.html and records the
//    measured values in docs/bird-db-provenance.json. Without --write it only reports.
// The expert prior always comes from the frozen v4.0 catalogue (data/catalogue-v4.0.json), so a
// refit never compounds an earlier one.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadApp, INDEX } from '../tests/lib/app-node.mjs';
import { readFeatures, split, toAnalysis } from '../tests/lib/real-data.mjs';
import { ROOT } from '../tests/lib/harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const FEAT = resolve(ROOT, args.features || 'data/xc-features.jsonl'), HTML = resolve(ROOT, args.html || INDEX), MIN = +(args['min-train'] || 3);
const PROV = resolve(ROOT, args.prov || 'docs/bird-db-provenance.json');
const html = readFileSync(HTML, 'utf8'), A = loadApp(html), M = A.MODEL;
const PRIOR = JSON.parse(readFileSync(resolve(ROOT, 'data/catalogue-v4.0.json'), 'utf8')), prior = new Map(PRIOR.map(b => [b.s, b]));

const LN = Math.log, sorted = a => [...a].sort((x, y) => x - y);
const quant = (a, p) => { const s = sorted(a); if (!s.length) return NaN; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const med = a => quant(a, 0.5), mad = a => { const m = med(a); return 1.4826 * med(a.map(v => Math.abs(v - m))); };
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const logit = p => { const q = Math.min(0.99, Math.max(0.01, p)); return LN(q / (1 - q)); };
const PRIOR_SIG = { h: 0.08, m: 0.15, l: 0.30, d: 0.15 };
const r3 = x => Math.round(x * 1000) / 1000;

// ── per-species estimation ─────────────────────────────────────────────────────
function fitSpecies(b0, recs, types) {
  if (recs.length < MIN) return null;
  const n = recs.length, W = recs.map(r => r.win.map(w => w.v4));
  const shrink = (mu0, sig0, muD, sD) => { const p0 = 1 / sig0 ** 2, pD = n / Math.max(0.05, sD) ** 2; return { mu: (mu0 * p0 + muD * pD) / (p0 + pD), v: 1 / (p0 + pD) }; };
  const s0 = PRIOR_SIG[b0.cf] || 0.15;
  // dominant frequency: per-recording median (equal weight per recording), spread over windows
  const lpk = W.flat().map(v => LN(v.pk[0][0])), recPk = W.map(ws => med(ws.map(v => LN(v.pk[0][0]))));
  const pk = shrink(LN(b0.fdom), s0, med(recPk), mad(lpk));
  const sp = Math.min(0.6, Math.max(0.05, Math.sqrt(mad(lpk) ** 2 + pk.v)));
  // band edges
  const f5 = W.flat().map(v => LN(v.f[0])), f95 = W.flat().map(v => LN(v.f[4]));
  const lo = shrink(LN(b0.fmin), s0, quant(f5, 0.1), mad(f5)).mu, hi = shrink(LN(b0.fmax), s0, quant(f95, 0.9), mad(f95)).mu;
  let fdom = Math.round(Math.exp(pk.mu) / 10) * 10;
  let fmin = Math.round(Math.min(Math.exp(lo), fdom / 1.12) / 10) * 10, fmax = Math.round(Math.max(Math.exp(hi), fdom * 1.12) / 10) * 10;
  if (fmax / fmin < 1.25) { fmin = Math.round(fdom / 1.12 / 10) * 10; fmax = Math.round(fdom * 1.12 / 10) * 10; }
  // texture, shrunk toward the vocal-type prototype with κ = 3 pseudo-recordings
  const T = types[b0.t] || types.c, K = 3;
  const recTx = W.map(ws => [med(ws.map(v => logit(v.c1))), med(ws.map(v => logit(v.c3))), med(ws.filter(v => v.iqr != null).map(v => LN(v.iqr + 0.02)))]);
  const tx = [0, 1, 2].map(d => { const vals = recTx.map(t => t[d]).filter(Number.isFinite); return (K * T[d === 2 ? 3 : d] + vals.length * (vals.length ? mean(vals) : 0)) / (K + vals.length); });
  const wsd = [W.flat().map(v => logit(v.c1)), W.flat().map(v => logit(v.c3)), W.flat().filter(v => v.iqr != null).map(v => LN(v.iqr + 0.02))].map(a => a.length > 2 ? mad(a) : T[2]);
  const ts = Math.sqrt((K * T[2] ** 2 + n * Math.max(0.3, mean(wsd)) ** 2) / (K + n));
  // note rate: detection probability (Laplace) and, with ≥3 detections, the measured 10–90 % range
  const all = W.flat(), det = all.filter(v => v.nr != null), rd = (det.length + 1) / (all.length + 2);
  let nr = b0.nr;
  if (det.length >= 3) { const lr = det.map(v => LN(v.nr)); nr = [Math.max(0.1, Math.round(Math.exp(quant(lr, 0.1) - 0.1) * 10) / 10), Math.round(Math.exp(quant(lr, 0.9) + 0.1) * 10) / 10]; if (nr[1] <= nr[0]) nr[1] = Math.round((nr[0] * 1.2) * 10) / 10; }
  return { fdom, fmin, fmax, nr, c: 'd', cf: 'd', x: { n, sp: r3(sp), tx: tx.map(r3), ts: r3(ts), rd: r3(rd) },
    audit: { dFdom: Math.exp(pk.mu) / b0.fdom - 1, recPkMed: Math.exp(med(recPk)), measuredTx: [0, 1, 2].map(d => mean(recTx.map(t => t[d]).filter(Number.isFinite))) } };
}

function buildPool(trainRecs, types) {
  const bySp = new Map(); for (const r of trainRecs) { if (!bySp.has(r.s)) bySp.set(r.s, []); bySp.get(r.s).push(r); }
  return A.BIRD_DB.map(b => { const b0 = { ...b, ...(prior.get(b.s) || {}) }; delete b0.x; const f = fitSpecies(b0, bySp.get(b.s) || [], types);
    return f ? { ...b0, fdom: f.fdom, fmin: f.fmin, fmax: f.fmax, nr: f.nr, c: f.c, cf: f.cf, x: f.x, _audit: f.audit } : b0; });
}

// Re-fit the type prototypes' centres from species with enough data (species without data use them).
function refitTypes(trainRecs) {
  const types = JSON.parse(JSON.stringify(M.types)), bySp = new Map();
  for (const r of trainRecs) { if (!bySp.has(r.s)) bySp.set(r.s, []); bySp.get(r.s).push(r); }
  const acc = {};
  for (const b of A.BIRD_DB) { const recs = bySp.get(b.s) || []; if (recs.length < MIN) continue; const t = (prior.get(b.s) || b).t;
    const W = recs.flatMap(r => r.win.map(w => w.v4)); (acc[t] = acc[t] || []).push([med(W.map(v => logit(v.c1))), med(W.map(v => logit(v.c3))), med(W.filter(v => v.iqr != null).map(v => LN(v.iqr + 0.02)))]); }
  for (const [t, list] of Object.entries(acc)) if (list.length >= 5) { types[t][0] = r3(med(list.map(l => l[0]))); types[t][1] = r3(med(list.map(l => l[1]))); const v = list.map(l => l[2]).filter(Number.isFinite); if (v.length) types[t][3] = r3(med(v)); }
  return { types, counts: Object.fromEntries(Object.entries(acc).map(([t, l]) => [t, l.length])) };
}

// ── evaluation on a set of recordings (window level, soft region prior) ───────
function evaluate(pool, recs) {
  let n = 0, top1 = 0, top3 = 0, nll = 0;
  for (const r of recs) {
    const regions = r.lat == null ? [] : A.getRegions(r.lat, r.lon), pri = A.regionPrior(regions, pool);
    for (const w of r.win) {
      const p = A.posterior(toAnalysis(w.v4), pool, pri), i = p.species.findIndex(e => e.b.s === r.s);
      n++; top1 += i === 0; top3 += i >= 0 && i < 3; nll -= LN(Math.max(1e-9, i >= 0 ? p.species[i].p : 1e-9));
    }
  }
  return { n, top1: top1 / (n || 1), top3: top3 / (n || 1), nll: nll / (n || 1), obj: (top1 + 0.5 * top3) / (n || 1) };
}

// ── main ───────────────────────────────────────────────────────────────────────
const rows = readFeatures(FEAT), { train, test } = split(rows);
const nSp = new Set(rows.map(r => r.s)).size;
console.log(`recordings: ${rows.length} (${nSp} species) → train ${train.length}, held out ${test.length} (recordist-disjoint)`);
const { types, counts } = refitTypes(train);
console.log(`type prototypes re-fitted from measured species: ${JSON.stringify(counts)}`);
Object.assign(M, { types });

// 3-fold recordist-grouped CV inside the training split
const fold = r => { let h = 2166136261; for (const c of `${r.s}|${r.rec}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) % 3; };
const folds = [0, 1, 2].map(k => ({ fitOn: train.filter(r => fold(r) !== k), evalOn: train.filter(r => fold(r) === k) }));
const foldPools = folds.map(f => buildPool(f.fitOn, types));
const cv = () => { const rs = folds.map((f, k) => evaluate(foldPools[k], f.evalOn)); const n = rs.reduce((s, r) => s + r.n, 0);
  return ['top1', 'top3', 'nll', 'obj'].reduce((o, k) => (o[k] = rs.reduce((s, r) => s + r[k] * r.n, 0) / (n || 1), o), { n }); };
const fmt = r => `top-1 ${(r.top1 * 100).toFixed(1)}%  top-3 ${(r.top3 * 100).toFixed(1)}%  NLL ${r.nll.toFixed(3)}  (${r.n} windows)`;
let best = cv(); console.log(`CV start            ${fmt(best)}`);
const grid = { spScale: [0.7, 0.85, 1, 1.2, 1.45], tsScale: [0.7, 0.85, 1, 1.2, 1.45], outlier: [0.02, 0.05, 0.1] };
for (let pass = 0; pass < 2; pass++) for (const [k, vals] of Object.entries(grid)) {
  let bv = M[k];
  for (const v of vals) { const old = M[k]; M[k] = v; const r = cv(); if (r.obj > best.obj + 1e-9) { best = r; bv = v; } M[k] = old; }
  M[k] = bv;
}
console.log(`CV tuned            ${fmt(best)}   spScale ${M.spScale}  tsScale ${M.tsScale}  outlier ${M.outlier}`);
let bt = { t: M.temp, nll: Infinity };
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.4]) { M.temp = t; const r = cv(); if (r.nll < bt.nll) bt = { t, nll: r.nll, r }; }
M.temp = bt.t; console.log(`CV temperature      T = ${bt.t}  ${fmt(bt.r)}`);

// final fit on the whole training split
const pool = buildPool(train, types), fitted = pool.filter(b => b.x);
console.log(`\nfitted ${fitted.length}/${A.BIRD_DB.length} species from ≥${MIN} training recordings each`);
const big = fitted.filter(b => Math.abs(b._audit.dFdom) > 0.25).sort((a, b) => Math.abs(b._audit.dFdom) - Math.abs(a._audit.dFdom));
console.log(`expert fdom off by >25 % vs real audio: ${big.length}`);
for (const b of big.slice(0, 25)) console.log(`  ${b.n.padEnd(30)} expert ${prior.get(b.s).fdom} Hz → measured ${Math.round(b._audit.recPkMed)} Hz (fitted ${b.fdom}, ${(b._audit.dFdom * 100).toFixed(0)}%)`);
const nearest = tx => Object.entries(types).map(([t, T]) => [t, ((tx[0] - T[0]) / T[2]) ** 2 + ((tx[1] - T[1]) / T[2]) ** 2 + (Number.isFinite(tx[2]) ? ((tx[2] - T[3]) / M.sigIQR) ** 2 : 0)]).sort((a, b) => a[1] - b[1])[0][0];
const tyOff = fitted.filter(b => nearest(b._audit.measuredTx) !== b.t);
console.log(`expert vocal type differs from the nearest measured texture: ${tyOff.length}/${fitted.length}${tyOff.length ? ' — e.g. ' + tyOff.slice(0, 12).map(b => `${b.n} (${b.t}→${nearest(b._audit.measuredTx)})`).join(', ') : ''}`);

if (!args.write) { console.log('\n(dry run — pass --write to update index.html and the provenance file)'); process.exit(0); }

// ── write-back ─────────────────────────────────────────────────────────────────
const S = JSON.stringify, byS = new Map(pool.map(b => [b.s, b]));
const a0 = html.indexOf('const BIRD_DB = ['), a1 = html.indexOf('\n];', a0) + 3;
let body = html.slice(a0, a1).replace(/  \{n:"[^]*?\},(?=\n)/g, blk => {
  const old = new Function(`return (${blk.trim().replace(/,$/, '')})`)(), b = byS.get(old.s);
  const e = b?.x ? { ...old, fdom: b.fdom, fmin: b.fmin, fmax: b.fmax, nr: b.nr, c: b.c, cf: b.cf, x: b.x } : (() => { const o = { ...old, ...(prior.get(old.s) ? { fdom: prior.get(old.s).fdom, fmin: prior.get(old.s).fmin, fmax: prior.get(old.s).fmax, nr: prior.get(old.s).nr, c: prior.get(old.s).c, cf: prior.get(old.s).cf } : {}) }; delete o.x; return o; })();
  let l1 = `  {n:${S(e.n)},s:${S(e.s)},fmin:${e.fmin},fmax:${e.fmax},fdom:${e.fdom},r:${S(e.r)},t:${S(e.t)},nr:${e.nr ? S(e.nr) : 'null'},c:${S(e.c)},cf:${S(e.cf)}`;
  if (e.sy && e.sy.length) l1 += `,sy:${S(e.sy)}`;
  if (e.x) l1 += `,x:{n:${e.x.n},sp:${e.x.sp},tx:${S(e.x.tx)},ts:${e.x.ts},rd:${e.x.rd}}`;
  return `${l1},\n   h:${S(e.h)},\n   f:${S(e.f)},w:${S(e.w)}},`;
});
let out = html.slice(0, a0) + body + html.slice(a1);
const setNum = (key, v) => { const re = new RegExp(`(\\n  ${key}:)[-0-9.]+`); if (!re.test(out)) throw new Error(`MODEL.${key} not found`); out = out.replace(re, `$1${v}`); };
out = out.replace(/(\n  spScale:)[-0-9.]+,tsScale:[-0-9.]+,/, `$1${M.spScale},tsScale:${M.tsScale},`);
setNum('outlier', M.outlier); setNum('temp', M.temp);
out = out.replace(/(\n  types:)\{[^\n]*\},/, `$1${S(types).replace(/"([a-z])":/g, '$1:')},`);
writeFileSync(HTML, out);
const prov = JSON.parse(readFileSync(PROV, 'utf8')), trainBySp = new Map();
for (const r of train) { if (!trainBySp.has(r.s)) trainBySp.set(r.s, []); trainBySp.get(r.s).push(r.xc); }
for (const p of prov) { const b = byS.get(p.s); if (b?.x) p.measured = { n: b.x.n, xc: trainBySp.get(p.s), fdom: b.fdom, fmin: b.fmin, fmax: b.fmax, nr: b.nr, sp: b.x.sp, rd: b.x.rd, dFdomPct: Math.round(b._audit.dFdom * 100) }; else delete p.measured; }
writeFileSync(PROV, JSON.stringify(prov, null, 1) + '\n');
console.log(`\nwrote ${HTML} (BIRD_DB + MODEL) and ${PROV}`);
