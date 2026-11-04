// Real-recording benchmark — held-out xeno-canto recordings (recordists never seen in fitting),
// scored offline from the measurements in data/xc-features.jsonl by three versions on the SAME
// audio windows:
//   v3.2 — its own front-end features (replayed AnalyserNode chain at harvest time), verbatim
//          scorer and catalogue (data/catalogue-v3.2.json), hard region filter;
//   v4.0 — expert catalogue + model as released (data/catalogue-v4.0.json, data/model-v4.0.json);
//   v4.1 — catalogue and model fitted to the training recordings (current index.html).
//
//   node tests/real-benchmark.mjs [--features data/xc-features.jsonl] [--occurrence]
//
// --occurrence adds the live iNaturalist seasonal prior (each recording's 50 km cell and month;
// responses cached in data/inat-cache.json so later runs are offline and reproducible).
// Statistics as in the synthetic benchmark: species-bootstrap CIs, McNemar, ECE/Brier.
// What it measures: identification of clean-ish archive recordings (quality A/B, MP3) cut into
// 8 s windows — closer to the field than synthetic clips, still not phone recordings by the public.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { loadApp } from './lib/app-node.mjs';
import { readFeatures, split, toAnalysis, toLegacy } from './lib/real-data.mjs';
import { metric, mcnemar, calibration, reliability, pct } from './lib/stats.mjs';
import { ROOT } from './lib/harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const FEAT = resolve(ROOT, args.features || 'data/xc-features.jsonl');
const rows = readFeatures(FEAT), { test, train } = split(rows);
const json = p => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

// three scorers
const V41 = loadApp(), V40 = loadApp();
const text = new Map(V41.BIRD_DB.map(b => [b.s, { h: b.h, f: b.f, w: b.w }]));
const CAT40 = json('data/catalogue-v4.0.json').map(b => ({ ...b, ...text.get(b.s) }));
Object.assign(V40.MODEL, json('data/model-v4.0.json'));
const sb = { Math, Float32Array, Float64Array, Array, Object, Number, JSON }; sb.globalThis = sb; vm.createContext(sb);
vm.runInContext(readFileSync(resolve(ROOT, 'tests/lib/legacy.js'), 'utf8'), sb);
const L = sb.LegacyChirping, CAT32 = json('data/catalogue-v3.2.json');
const aliases = new Map(V41.BIRD_DB.map(b => [b.s, new Set([b.s, ...(b.sy || [])])]));
const isTrue = (s, cand) => aliases.get(s)?.has(cand) ?? s === cand;

// optional live occurrence prior, per 0.1° cell and recording month
const CACHE = resolve(ROOT, 'data/inat-cache.json'), cache = existsSync(CACHE) ? json('data/inat-cache.json') : {};
const months = m => [(m + 10) % 12 + 1, m, m % 12 + 1];
async function occFor(r) {
  if (!args.occurrence || r.lat == null || !r.date) return null;
  const m = +String(r.date).slice(5, 7); if (!(m >= 1 && m <= 12)) return null;
  const key = `${r.lat.toFixed(1)},${r.lon.toFixed(1)}:${m}`;
  if (!(key in cache)) {
    try {
      const url = `https://api.inaturalist.org/v1/observations/species_counts?taxon_id=3&lat=${r.lat.toFixed(4)}&lng=${r.lon.toFixed(4)}&radius=50&month=${months(m).join(',')}&verifiable=true&captive=false&quality_grade=research&per_page=500`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) }); const d = await res.json(); await new Promise(z => setTimeout(z, 1100));
      const counts = {}; let total = 0, minC = Infinity;
      for (const x of d.results || []) { const nm = String(x.taxon?.name || '').toLowerCase().split(/\s+/).slice(0, 2).join(' '); if (!nm.includes(' ')) continue; counts[nm] = (counts[nm] || 0) + x.count; total += x.count; minC = Math.min(minC, x.count); }
      cache[key] = { src: 'iNaturalist', counts, total, nSpecies: Object.keys(counts).length, months: months(m), floor: (d.total_results || 0) > (d.results || []).length && isFinite(minC) ? minC / 2 : 0 };
    } catch { cache[key] = null; }
  }
  return cache[key];
}

// score every held-out window
const out = [];
for (const r of test) {
  const regions = r.lat == null ? [] : V41.getRegions(r.lat, r.lon), occ = await occFor(r);
  const legacyRegion = r.lat == null ? null : L.getRegion(r.lat, r.lon);
  const pri = { v41g: () => 1, v41r: V41.regionPrior(regions, V41.BIRD_DB), v40g: () => 1, v40r: V40.regionPrior(regions, CAT40) };
  if (occ) { pri.v41o = V41.makePrior(V41.BIRD_DB, regions, occ); pri.v40o = V40.makePrior(CAT40, regions, occ); }
  const recPost = {};
  r.win.forEach((w, wi) => {
    const a = toAnalysis(w.v4), row = { si: r.s, xc: r.xc, wi, snr: w.v4.snr };
    for (const [k, prior] of Object.entries(pri)) {
      const [S, pool] = k.startsWith('v41') ? [V41, V41.BIRD_DB] : [V40, CAT40], p = S.posterior(a, pool, prior);
      const i = p.species.findIndex(e => e.b.s === r.s);
      row[k] = i + 1; if (k.endsWith('r')) { row[k + 'p'] = p.species[0].p; row[k + 't'] = i === 0; }
      const acc = recPost[k] = recPost[k] || new Map(); for (const e of p.species) acc.set(e.b.s, (acc.get(e.b.s) || 0) + e.p / r.win.length);
    }
    const lf = toLegacy(w.v32);
    for (const [k, reg] of [['v32g', null], ['v32r', legacyRegion]]) { const rk = L.legacyRank(lf, CAT32, reg); row[k] = (rk.findIndex(e => isTrue(r.s, e.b.s)) + 1) || 999; }
    out.push(row);
  });
  // recording level: mean of the window posteriors
  const recRow = { si: r.s, xc: r.xc, rec: true };
  for (const [k, acc] of Object.entries(recPost)) { const ranked = [...acc.entries()].sort((a, b) => b[1] - a[1]); recRow[k] = ranked.findIndex(([s]) => s === r.s) + 1; }
  out.push(recRow);
}
if (args.occurrence) writeFileSync(CACHE, JSON.stringify(cache) + '\n');

const W = out.filter(r => !r.rec), R = out.filter(r => r.rec);
const nSp = new Set(test.map(r => r.s)).size;
console.log(`\n=== Chirping real-recording benchmark — ${test.length} held-out recordings (${nSp} species, ${W.length} windows of 8 s); fitted on ${train.length} recordings by other recordists ===`);
console.log('single-attempt accuracy, 95 % species-bootstrap CI\n');
const line = (label, rows, k, n) => console.log(`  ${label.padEnd(34)} top-1 ${pct(metric(rows, r => r[k] === 1 ? 1 : 0)).padEnd(22)} top-3 ${pct(metric(rows, r => r[k] > 0 && r[k] <= 3 ? 1 : 0))}${n ? '' : ''}`);
console.log('[per 8 s window — what one app recording sees]');
line('v3.2  global', W, 'v32g'); line('v4.0  global', W, 'v40g'); line('v4.1  global', W, 'v41g');
line('v3.2  region (hard filter)', W, 'v32r'); line('v4.0  region', W, 'v40r'); line('v4.1  region', W, 'v41r');
if (W[0]?.v41o !== undefined) { line('v4.0  region + iNat season prior', W.filter(r => r.v40o !== undefined), 'v40o'); line('v4.1  region + iNat season prior', W.filter(r => r.v41o !== undefined), 'v41o'); }
console.log('[per recording — window posteriors averaged]');
line('v4.0  region', R, 'v40r'); line('v4.1  region', R, 'v41r');

let fail = 0; const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };
const m1 = mcnemar(W, r => r.v41r === 1, r => r.v40r === 1), m2 = mcnemar(W, r => r.v41r === 1, r => r.v32r === 1);
console.log(`\nMcNemar (window, region top-1): v4.1 vs v4.0 — ${m1.aOnly} vs ${m1.bOnly} windows right only by one, p = ${m1.p.toExponential(1)}; v4.1 vs v3.2 — ${m2.aOnly} vs ${m2.bOnly}, p = ${m2.p.toExponential(1)}`);
for (const [k, lab] of [['v40r', 'v4.0'], ['v41r', 'v4.1']]) {
  const c = calibration(W.map(r => ({ pTop: r[k + 'p'], topIsTrue: r[k + 't'] })));
  console.log(`  ${lab} calibration (region, window): ECE ${c.ece.toFixed(3)}, Brier ${c.brier.toFixed(3)}; reliability ${reliability(c.bins)}`);
}
console.log('\nv4.1 region top-1 by window SNR:');
for (const [lo, hi] of [[-Infinity, 6], [6, 15], [15, Infinity]]) { const rs = W.filter(r => r.snr >= lo && r.snr < hi); if (rs.length) console.log(`  ${lo === -Infinity ? '< 6 dB' : hi === Infinity ? '≥ 15 dB' : '6–15 dB'}: ${pct(metric(rs, r => r.v41r === 1 ? 1 : 0))}  (${rs.length} windows)`); }
check(!(m1.bOnly > m1.aOnly && m1.p < 0.05), 'v4.1 (fitted) is not significantly worse than v4.0 (expert) on held-out recordists');
console.log(fail ? `\n${fail} check(s) FAILED` : '\nreal-recording benchmark checks passed ✓');
process.exit(fail ? 1 : 0);
