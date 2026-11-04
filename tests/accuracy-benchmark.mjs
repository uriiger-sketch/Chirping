// Chirping accuracy benchmark — v4 vs the preserved v3.2 classifier on IDENTICAL synthetic
// waveforms, through each version's real front-end (v4: analyzePCM on raw PCM; v3.2: AnalyserNode
// in an OfflineAudioContext behind HP/LP/compressor, every-10th-bin decimation, old scorer).
//
//   node tests/accuracy-benchmark.mjs          (BENCH_TRIALS=2, BENCH_SEED=5000 by default)
//
// What this measures — and what it cannot. The generator (tests/lib/synth.js) renders each
// catalogue species from its own catalogue entry with individual pitch spread, note-rate jitter,
// several realisations per vocal type, pink/traffic/wind noise at a stated in-band SNR and a random
// recording level. Model hyper-parameters were fitted on seed 1000; this run defaults to the
// held-out seed 5000. It is a SELF-CONSISTENCY test: it shows the measurement chain is sound and
// the probabilities calibrated for sounds that obey the catalogue. It says nothing about how well
// the catalogue matches real birds — that needs labelled field recordings (see
// docs/physics-audit.md, "Limits").
//
// Statistics: single-attempt accuracy (no best-of-N), 95 % bootstrap CIs resampled by SPECIES
// (trials of one species are correlated), McNemar's exact-continuity test for v4 vs v3.2 paired on
// the same clips, expected calibration error (ECE) and Brier score of the v4 top-1 probability,
// an accuracy-vs-noise monotonicity check (±2 SE), and a 20 % species leave-out open-set test.
import { loadPlaywright, chromiumPath, openApp } from './lib/harness.mjs';
import { metric, mcnemar as mcnemarAB, calibration, reliability, pct as pc } from './lib/stats.mjs';

const TRIALS = +(process.env.BENCH_TRIALS || 2), SEED = +(process.env.BENCH_SEED || 5000);
const CONDS = { clean: { snr: 25, traffic: 0, wind: 0 }, moderate: { snr: 12, traffic: 0.3, wind: 0 },
  noisy: { snr: 3, traffic: 0.6, wind: 0.5 }, extreme: { snr: -3, traffic: 0.6, wind: 0.8 } };

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const app = await openApp(browser, { legacy: true });
const { page } = app;
const nSpecies = await page.evaluate(() => BIRD_DB.length);
const t0 = Date.now(), cases = [];
for (const [cond, c] of Object.entries(CONDS)) {
  for (let s0 = 0; s0 < nSpecies; s0 += 20) {
    const chunk = await page.evaluate(async ({ s0, cond, c, TRIALS, SEED }) => {
      const out = [], Sy = ChirpSynth, L = LegacyChirping;
      for (let si = s0; si < Math.min(BIRD_DB.length, s0 + 20); si++) for (let t = 0; t < TRIALS; t++) {
        const b = BIRD_DB[si], seed = SEED + si * 97 + t * 7919 + Math.round(c.snr * 13) + 1009 * Object.keys({ clean: 0, moderate: 0, noisy: 0, extreme: 0 }).indexOf(cond);
        const fs = t % 2 ? 44100 : 48000, region = b.r[t % b.r.length], R = Sy.rng(seed + 3);
        const voc = Sy.vocalisation(b, seed, { fs }), noise = Sy.fieldNoise(seed + 1, fs, voc.pcm.length, c);
        const x = Sy.mix(voc, noise, c.snr, R.logRange(0.03, 0.3)); // −30…−10 dBFS peak: real recording levels
        const a = analyzePCM(x, fs);
        const pg = posterior(a, BIRD_DB, () => 1), pr = posterior(a, BIRD_DB, regionPrior([region], BIRD_DB));
        const rank = p => p.species.findIndex(e => e.b === b) + 1;
        const lf = L.computeFeatures(await L.legacyFrames(x, fs));
        const lg = L.legacyRank(lf, BIRD_DB, null), lr = L.legacyRank(lf, BIRD_DB, region);
        out.push({ si, t, cond, v4g: rank(pg), v4r: rank(pr), pTop: pr.species[0].p, topIsTrue: pr.species[0].b === b, winner: pg.species[0].b.n,
          lgg: lg.findIndex(e => e.b === b) + 1, lgr: (lr.findIndex(e => e.b === b) + 1) || 999,
          feat: { peaks: a.peaks.map(p => ({ hz: p.hz, share: p.share })), f5: a.f5, f95: a.f95, conc1: a.conc1, conc3: a.conc3, noteRate: a.noteRate, pitchIQR: a.pitchIQR }, region });
      }
      return out;
    }, { s0, cond, c, TRIALS, SEED });
    cases.push(...chunk);
    process.stdout.write(`\r  ${cond.padEnd(8)} species ${Math.min(nSpecies, s0 + 20)}/${nSpecies}  (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
  }
}
console.log();

// Open-set: hide 20 % of species from the pool; their clips should not be confidently assigned.
const openSet = await page.evaluate(({ moderate }) => {
  const R = ChirpSynth.rng(4242), held = new Set();
  while (held.size < Math.round(BIRD_DB.length * 0.2)) held.add(Math.floor(R() * BIRD_DB.length));
  const pool = BIRD_DB.filter((_, i) => !held.has(i)), known = [], unknown = [];
  for (const c of moderate) {
    const p = posterior(c.feat, pool, regionPrior([c.region], pool)), b = BIRD_DB[c.si];
    (held.has(c.si) ? unknown : known).push({ pTop: p.species[0].p, pOther: p.pOther, right: p.species[0].b === b });
  }
  return { known, unknown };
}, { moderate: cases.filter(c => c.cond === 'moderate') });
await app.close(); await browser.close();

// ── statistics (tests/lib/stats.mjs) ─────────────────────────────────────────
const mcnemar = (rows, a, b) => { const r = mcnemarAB(rows, a, b); return { v4Only: r.aOnly, oldOnly: r.bOnly, p: r.p }; };
let fail = 0; const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };
console.log(`\n=== Chirping accuracy benchmark — ${nSpecies} species × ${TRIALS} clips × ${Object.keys(CONDS).length} conditions, seed ${SEED} (${((Date.now() - t0) / 1000).toFixed(0)} s) ===`);
console.log('single-attempt accuracy, 95 % species-bootstrap CI; "region" = soft region prior (v4) / hard region filter (v3.2)\n');
const summary = {};
for (const cond of Object.keys(CONDS)) {
  const rows = cases.filter(r => r.cond === cond), c = CONDS[cond];
  const m = { v4r1: metric(rows, r => r.v4r === 1 ? 1 : 0), v4r3: metric(rows, r => r.v4r <= 3 ? 1 : 0), v4g1: metric(rows, r => r.v4g === 1 ? 1 : 0), v4g3: metric(rows, r => r.v4g <= 3 ? 1 : 0),
    o_r1: metric(rows, r => r.lgr === 1 ? 1 : 0), o_r3: metric(rows, r => r.lgr <= 3 ? 1 : 0), o_g1: metric(rows, r => r.lgg === 1 ? 1 : 0), o_g3: metric(rows, r => r.lgg <= 3 ? 1 : 0) };
  const mc = mcnemar(rows, r => r.v4r === 1, r => r.lgr === 1), cal = calibration(rows);
  summary[cond] = { m, mc, cal };
  console.log(`[${cond.toUpperCase()}] in-band SNR ${c.snr} dB${c.traffic ? ', traffic' : ''}${c.wind ? ', wind gusts' : ''}`);
  console.log(`  region  top-1  v4 ${pc(m.v4r1).padEnd(22)} v3.2 ${pc(m.o_r1)}`);
  console.log(`  region  top-3  v4 ${pc(m.v4r3).padEnd(22)} v3.2 ${pc(m.o_r3)}`);
  console.log(`  global  top-1  v4 ${pc(m.v4g1).padEnd(22)} v3.2 ${pc(m.o_g1)}`);
  console.log(`  global  top-3  v4 ${pc(m.v4g3).padEnd(22)} v3.2 ${pc(m.o_g3)}`);
  console.log(`  McNemar (region top-1): v4-only right ${mc.v4Only}, v3.2-only right ${mc.oldOnly}, p = ${mc.p.toExponential(1)}`);
  console.log(`  v4 calibration: ECE ${cal.ece.toFixed(3)}, Brier ${cal.brier.toFixed(3)}; reliability ${reliability(cal.bins)}`);
  check(!(mc.oldOnly > mc.v4Only && mc.p < 0.05), 'v4 is not significantly worse than v3.2 on the same clips');
  if (cond !== 'extreme') check(cal.ece <= 0.07, `v4 top-1 probability calibrated (ECE ${cal.ece.toFixed(3)} ≤ 0.07; design target 0.05)`);
}
const order = Object.keys(CONDS);
console.log('\nSanity checks:');
for (let i = 1; i < order.length; i++) {
  const a = summary[order[i - 1]].m.v4r1, b = summary[order[i]].m.v4r1;
  check(b.mean <= a.mean + 2 * Math.hypot(a.se, b.se), `v4 accuracy does not rise with noise: ${order[i - 1]} ${(a.mean * 100).toFixed(1)}% → ${order[i]} ${(b.mean * 100).toFixed(1)}% (±2 SE)`);
}
const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const ks = openSet.known.map(k => k.pTop), us = openSet.unknown.map(u => u.pTop);
let auc = 0; for (const k of ks) for (const u of us) auc += k > u ? 1 : k === u ? 0.5 : 0; auc /= (ks.length * us.length) || 1;
console.log(`\nOpen set (moderate; 20 % of species hidden from the pool): mean top probability known ${mean(ks).toFixed(2)} vs unseen ${mean(us).toFixed(2)},` +
  ` AUROC ${auc.toFixed(2)}; mean p(not in catalogue) known ${mean(openSet.known.map(k => k.pOther)).toFixed(3)} vs unseen ${mean(openSet.unknown.map(u => u.pOther)).toFixed(3)}`);
console.log('  (honest reading: summary acoustic features cannot reliably flag an unseen species when the catalogue is dense; the UI reports low-probability results as uncertain instead)');

const conf = {}; for (const r of cases.filter(r => r.cond === 'moderate' && r.v4g !== 1)) { const k = `${r.si}`; (conf[k] = conf[k] || {})[r.winner] = (conf[k][r.winner] || 0) + 1; }
const html = (await import('node:fs')).readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const DB = new Function(`return ${html.match(/const BIRD_DB = (\[[\s\S]*?\n\]);/)[1]}`)();
const top = Object.entries(conf).map(([si, w]) => { const [n, k] = Object.entries(w).sort((a, b) => b[1] - a[1])[0]; return [DB[si].n, n, k]; }).sort((a, b) => b[2] - a[2]).slice(0, 10);
console.log(`\nMost frequent v4 confusions (moderate, global pool):`);
for (const [t, w, k] of top) console.log(`  ${t.padEnd(28)} → ${w.padEnd(28)} ${k}/${TRIALS}`);
console.log('\nPerfect-measurement ceiling of the catalogue itself: run `node tests/db-lint.mjs`.');
if (app.errors.length) { console.log('PAGE ERRORS:', app.errors); fail++; }
console.log(fail ? `\n${fail} check(s) FAILED` : '\nbenchmark checks passed ✓');
process.exit(fail ? 1 : 0);
