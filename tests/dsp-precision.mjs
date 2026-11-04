// Chirping DSP precision test — known-truth signals through the REAL app code (analyzePCM in
// index.html, in Chromium), with the v3.2 front-end measured alongside on the same signals.
// Every number has a stated target; the run fails if any v4 target is missed.
//
//   node tests/dsp-precision.mjs
//
// SNR convention (all tests): in-band power ratio over 150 Hz–12 kHz, signal power taken while
// the signal is on, noise = white Gaussian. Physics and tolerances: .claude/skills/bioacoustic-dsp.
import { loadPlaywright, chromiumPath, openApp } from './lib/harness.mjs';

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const app = await openApp(browser, { legacy: true });
const { page } = app;

const R = await page.evaluate(async () => {
  const R = ChirpSynth.rng(20261028), sigma = 0.003;
  const inband = fs => (12000 - 150) / (fs / 2);
  const amp = (fs, snr) => Math.sqrt(2 * sigma * sigma * inband(fs) * 10 ** (snr / 10)); // sine of in-band SNR
  const white = n => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = sigma * R.normal(); return x; };
  // Notes of a steady tone: 150 ms on / 100 ms off between 0.5 s and 2.5 s, 5 ms ramps.
  function tones(fs, f, snr, on = 0.15, off = 0.1) {
    const x = white(Math.round(3.2 * fs)), A = amp(fs, snr), ph = R() * 6.28;
    for (let i = Math.round(0.5 * fs); i < Math.round(2.5 * fs); i++) { const c = (i / fs - 0.5) % (on + off);
      if (c < on) x[i] += A * Math.min(1, c / 0.005, (on - c) / 0.005) * Math.sin(2 * Math.PI * f * i / fs + ph); }
    return x;
  }
  const out = { tones: [], legacyTones: [], band: [], trill: [], snr: [], noise: [], wind: [], perf: {} };

  // 1. Tone frequency accuracy & detection (log-uniform 150 Hz – 11 kHz)
  for (const fs of [44100, 48000]) for (const snr of [0, 6, 10, 20, 30]) {
    let det = 0, se = 0, mx = 0, n = 0, ldet = 0, lse = 0, lmx = 0;
    for (let i = 0; i < 30; i++) {
      const f = 150 * Math.exp(R() * Math.log(11000 / 150)), x = tones(fs, f, snr); n++;
      const a = analyzePCM(x, fs);
      if (!a.silent && a.peaks.some(p => Math.abs(Math.log(p.hz / f)) < 0.03)) {
        det++; const p = a.peaks.reduce((b, p) => Math.abs(p.hz - f) < Math.abs(b.hz - f) ? p : b); se += (p.hz - f) ** 2; mx = Math.max(mx, Math.abs(p.hz - f)); }
      if (fs === 48000) { // legacy front-end on the same signal
        const L = LegacyChirping, feats = L.computeFeatures(await L.legacyFrames(x, fs)), tol = Math.max(0.03 * f, 1.5 * L.S.hzPerBin);
        const lp = feats.peaks.filter(p => Math.abs(p.hz - f) <= tol);
        if (feats.signal >= 0.006 && lp.length) { ldet++; const p = lp[0]; lse += (p.hz - f) ** 2; lmx = Math.max(lmx, Math.abs(p.hz - f)); }
      }
    }
    out.tones.push({ fs, snr, n, detect: det / n, rmsHz: Math.sqrt(se / Math.max(1, det)), maxHz: mx });
    if (fs === 48000) out.legacyTones.push({ fs, snr, n, detect: ldet / n, rmsHz: Math.sqrt(lse / Math.max(1, ldet)), maxHz: lmx });
  }
  // 2. Energy quantiles F5/F95 on band-limited noise with known flat edges (sum of 400 random sines)
  for (const [fa, fb] of [[800, 2500], [2000, 6000], [4000, 9000]]) for (const snr of [10, 20]) {
    const fs = 48000, x = white(Math.round(3.2 * fs)), K = 400, fr = [], ph = [], A = amp(fs, snr) * Math.sqrt(2 / K) / Math.SQRT2;
    for (let k = 0; k < K; k++) { fr.push(fa + (fb - fa) * (k + R()) / K); ph.push(R() * 6.28); }
    for (let i = Math.round(0.5 * fs); i < Math.round(2.5 * fs); i++) { const c = (i / fs - 0.5) % 0.3; if (c >= 0.2) continue;
      let s = 0; for (let k = 0; k < K; k++) s += Math.sin(2 * Math.PI * fr[k] * i / fs + ph[k]); x[i] += A * Math.min(1, c / 0.005, (0.2 - c) / 0.005) * s; }
    const a = analyzePCM(x, fs), t5 = fa + 0.05 * (fb - fa), t95 = fa + 0.95 * (fb - fa);
    out.band.push({ fa, fb, snr, f5: a.f5, f95: a.f95, err5: a.f5 / t5 - 1, err95: a.f95 / t95 - 1 });
  }
  // 3. Note (trill) rate, 50 % duty, 3 kHz notes at 10 dB
  for (const rate of [2, 5, 10, 20, 30, 40]) {
    const fs = 48000, x = white(Math.round(3.4 * fs)), A = amp(fs, 10), on = 0.5 / rate;
    for (let i = Math.round(0.5 * fs); i < Math.round(2.9 * fs); i++) { const c = (i / fs - 0.5) % (1 / rate); if (c < on) x[i] += A * Math.sin(Math.PI * c / on) * Math.sin(2 * Math.PI * 3000 * i / fs); }
    const a = analyzePCM(x, fs); out.trill.push({ rate, est: a.noteRate, err: a.noteRate ? a.noteRate / rate - 1 : null });
  }
  // 4. SNR estimate on sustained notes (2 s on)
  for (const snr of [0, 10, 20]) { const errs = [];
    for (let i = 0; i < 10; i++) { const a = analyzePCM(tones(48000, 500 + R() * 6000, snr, 2.0, 0.01), 48000); errs.push(a.snrDb - snr); }
    out.snr.push({ snr, bias: errs.reduce((s, e) => s + e, 0) / errs.length, maxAbs: Math.max(...errs.map(Math.abs)) }); }
  // 4b. Digital-silence padding (exact zeros for 30 % of the clip) must not collapse the noise floor
  { const fs = 48000, x = tones(fs, 3000, 10, 2.0, 0.01), pad = new Float32Array(Math.round(0.7 * fs)), y = new Float32Array(x.length + 2 * pad.length);
    y.set(pad, 0); y.set(x, pad.length); y.set(pad, pad.length + x.length); const a = analyzePCM(y, fs); out.pad = { snr: a.snrDb }; }
  // 5. False activity on pure white noise
  for (let i = 0; i < 8; i++) out.noise.push(analyzePCM(white(4 * 48000), 48000).activeFrac);
  // 6. Wind gust (brown noise, 1.2 s) + a 3.2 kHz whistle; and a 200 Hz pure tone that must NOT be called wind
  for (const gain of [0.3, 1, 1, 1, 2]) { const fs = 48000, n = 4 * fs, x = white(n); let b = 0;
    for (let i = 0; i < n; i++) { b = 0.999 * b + R.normal() * 0.006; x[i] += (i / fs > 1 && i / fs < 2.2 ? gain : 0.02) * b; }
    for (let i = Math.round(2.5 * fs); i < Math.round(3.5 * fs); i++) x[i] += 0.006 * Math.sin(2 * Math.PI * 3200 * i / fs);
    const a = analyzePCM(x, fs); out.wind.push({ case: `gust ×${gain} + 3.2 kHz whistle`, windFrac: a.windFrac, peak: a.peak }); }
  for (const f of [160, 200, 300, 450]) { const a = analyzePCM(tones(48000, f, 10), 48000); out.wind.push({ case: `${f} Hz tone`, f, windFrac: a.windFrac, peak: a.peak }); }
  // 7. Throughput: 60 s of audio, streamed in 4096-sample chunks as the tap delivers it
  { const fs = 48000, x = white(60 * fs), an = createAnalyzer(fs); let t0 = performance.now();
    for (let i = 0; i < x.length; i += 4096) an.push(x.subarray(i, i + 4096));
    const tPush = performance.now() - t0; t0 = performance.now(); an.finish(); out.perf = { pushMsPerAudioSec: tPush / 60, finishMs: performance.now() - t0 }; }
  return out;
});

let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };
const f2 = x => x.toFixed(2), pc = x => (x * 100).toFixed(1) + '%';
console.log('\n=== Chirping DSP precision (v4 analyzePCM, real app code in Chromium) ===\n');
console.log('Tone peak frequency (30 tones per row, 150 Hz–11 kHz, notes 150 ms):');
for (const t of R.tones) {
  const L = R.legacyTones.find(l => l.fs === t.fs && l.snr === t.snr);
  console.log(`  fs ${t.fs}  SNR ${String(t.snr).padStart(2)} dB  detect ${pc(t.detect).padStart(6)}  RMS ${f2(t.rmsHz).padStart(5)} Hz  max ${f2(t.maxHz).padStart(5)} Hz` +
    (L ? `   | v3.2: detect ${pc(L.detect).padStart(6)}  RMS ${f2(L.rmsHz).padStart(6)} Hz  max ${f2(L.maxHz).padStart(6)} Hz` : ''));
}
for (const t of R.tones) {
  if (t.snr >= 6) check(t.detect >= 0.99, `detection ≥ 99 % at ${t.snr} dB (fs ${t.fs}): ${pc(t.detect)}`);
  if (t.snr >= 10) check(t.rmsHz <= 2, `RMS error ≤ 2 Hz at ${t.snr} dB (fs ${t.fs}): ${f2(t.rmsHz)} Hz`);
}
console.log('\nF5/F95 on band-limited noise:');
for (const b of R.band) check(Math.abs(b.err5) <= 0.03 && Math.abs(b.err95) <= 0.03,
  `${b.fa}–${b.fb} Hz @${b.snr} dB: F5 ${b.f5.toFixed(0)} (${(b.err5 * 100).toFixed(1)}%), F95 ${b.f95.toFixed(0)} (${(b.err95 * 100).toFixed(1)}%)  [±3 %]`);
console.log('\nNote rate (autocorrelation of the band envelope):');
for (const t of R.trill) check(t.err !== null && Math.abs(t.err) <= 0.05, `${t.rate}/s → ${t.est ? t.est.toFixed(2) : 'null'} (${t.err === null ? '—' : (t.err * 100).toFixed(1) + '%'})  [±5 %]`);
console.log('\nSNR estimate (sustained notes):');
for (const s of R.snr) check(Math.abs(s.bias) <= 1 && s.maxAbs <= 1.5, `${s.snr} dB → bias ${f2(s.bias)} dB, max |err| ${f2(s.maxAbs)} dB  [bias ±1 dB]`);
check(Math.abs(R.pad.snr - 10) <= 1, `digital-silence padding: SNR ${f2(R.pad.snr)} dB for a 10 dB signal  [±1 dB]`);
const fa = R.noise.reduce((s, v) => s + v, 0) / R.noise.length;
console.log('\nRobustness:');
check(fa <= 0.01, `false activity on white noise: ${pc(fa)}  [≤ 1 %]`);
for (const w of R.wind) {
  if (w.f) check(w.windFrac <= 0.01 && Math.abs(w.peak - w.f) < 2, `${w.case} kept (not wind): flagged ${pc(w.windFrac)}, peak ${w.peak.toFixed(2)} Hz`);
  else check(w.windFrac >= 0.15 && Math.abs(w.peak - 3200) < 20, `${w.case}: gust rejected (${pc(w.windFrac)} of frames flagged), peak ${w.peak.toFixed(1)} Hz`);
}
console.log(`\nThroughput: ${R.perf.pushMsPerAudioSec.toFixed(1)} ms CPU per second of audio while recording; finish() on 60 s: ${R.perf.finishMs.toFixed(0)} ms`);
check(R.perf.pushMsPerAudioSec < 100, 'streaming STFT keeps up with real time with ≥10× headroom');
if (app.errors.length) { console.log('PAGE ERRORS:', app.errors); fail++; }
console.log(fail ? `\n${fail} check(s) FAILED` : '\nall precision targets met ✓');
await app.close(); await browser.close();
process.exit(fail ? 1 : 0);
