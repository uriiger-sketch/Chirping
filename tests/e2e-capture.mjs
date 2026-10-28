// End-to-end capture test: a synthetic bird call is fed to Chromium as the MICROPHONE, the real
// UI is driven (tap record → wait → tap stop) and the result cards are checked. Exercises
// getUserMedia → AudioWorklet tap → streaming STFT → posterior → occurrence prior → cards.
// Also verifies the tap is sample-exact in an OfflineAudioContext, and that the app still
// classifies with every network request failing (offline → region prior).
//
//   node tests/e2e-capture.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { loadPlaywright, chromiumPath, openApp, ROOT } from './lib/harness.mjs';

// Synthesise the clip in Node with the same generator the benchmark uses.
const sandbox = { Math, Float32Array, Float64Array, Array, Object, Number, JSON };
sandbox.globalThis = sandbox; vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'tests/lib/synth.js'), 'utf8'), sandbox);
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const DB = new Function(`return ${html.match(/const BIRD_DB = (\[[\s\S]*?\n\]);/)[1]}`)();
const SPECIES = 'Turdus migratorius', bird = DB.find(b => b.s === SPECIES), FS = 48000;
const Sy = sandbox.ChirpSynth;
const voc = Sy.vocalisation(bird, 4242, { fs: FS, seconds: 4 });
const pcm = Sy.mix(voc, Sy.fieldNoise(4243, FS, voc.pcm.length, { traffic: 0.2 }), 15, 0.25);
const lead = new Float32Array(Math.round(0.6 * FS)); // fake device starts before the tap is armed
const clip = Float32Array.from([...lead, ...pcm, ...lead]);

function wav16(x, fs) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + 2 * i);
  return b;
}
const dir = mkdtempSync(join(tmpdir(), 'chirping-e2e-')), wavPath = join(dir, 'robin.wav');
writeFileSync(wavPath, wav16(clip, FS));

const inatMock = () => ({ total_results: 3, results: [
  { count: 420, taxon: { name: 'Turdus migratorius' } }, { count: 300, taxon: { name: 'Cardinalis cardinalis' } },
  ...DB.filter(b => b.r.includes('na')).slice(0, 40).map((b, i) => ({ count: 5 + i, taxon: { name: b.s } })) ] });
const gbifMock = u => ({ count: u.includes('scientificName=Turdus') ? 1800 : u.includes('scientificName=') ? 60 : 250000 });

const { chromium } = await loadPlaywright();
let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };

async function recordOnce(label, { mocks, fakeFile = true }) {
  const browser = await chromium.launch({ executablePath: chromiumPath(), args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ...(fakeFile ? [`--use-file-for-fake-audio-capture=${wavPath}%noloop`] : [])] });
  const app = await openApp(browser, { mocks, contextOptions: { permissions: ['microphone', 'geolocation'], geolocation: { latitude: 40.71, longitude: -74.0 } } });
  const { page } = app;
  if (!fakeFile) await page.evaluate(async b64 => { // fallback: replace the mic with the decoded clip
    const ctx0 = new AudioContext(), buf = await ctx0.decodeAudioData(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
    navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const s = c.createBufferSource(); s.buffer = buf; const d = c.createMediaStreamDestination(); s.connect(d); s.start(); return d.stream; };
  }, readFileSync(wavPath).toString('base64'));
  await page.waitForFunction(() => typeof S !== 'undefined' && S.geoReady, null, { timeout: 5000 }).catch(() => {});
  await page.click('#recBtn');
  await page.waitForTimeout(clip.length / FS * 1000 - 300);
  const live = await page.evaluate(() => ({ kind: S.tapKind, n: S.nSamples, fs: S.fs, got: S.gotSignal }));
  await page.click('#recBtn');
  await page.waitForSelector('#results.show', { timeout: 20000 }).catch(() => {});
  const res = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.bcard')].map(c => ({ n: c.querySelector('.bcard-common')?.textContent, p: c.querySelector('.conf-pct')?.textContent, badge: c.querySelector('.rgn-badge')?.textContent })),
    meta: document.getElementById('resMeta')?.textContent, note: document.querySelector('.res-note')?.textContent,
    feats: ['fPeak', 'fBand', 'fSnr', 'fTone', 'fRate'].map(id => document.getElementById(id)?.textContent), a: S.lastAnalysis && { peak: S.lastAnalysis.peak, snr: S.lastAnalysis.snrDb } }));
  console.log(`\n[${label}] tap=${live.kind} samples=${live.n} (${(live.n / live.fs).toFixed(2)} s @ ${live.fs} Hz) signal=${live.got}`);
  console.log(`  features: ${res.feats.join(' | ')}`);
  console.log(`  meta: ${res.meta}`);
  res.cards.forEach((c, i) => console.log(`  #${i + 1} ${c.n} ${c.p} — ${c.badge}`));
  console.log(`  ${res.note}`);
  await app.close(); await browser.close();
  return { live, res, errors: app.errors };
}

console.log('=== Chirping end-to-end capture ===');
console.log(`clip: ${bird.n}, ${(clip.length / FS).toFixed(1)} s, truth peak ${voc.truth.f.toFixed(0)} Hz, written to ${wavPath}`);
let r = await recordOnce('fake microphone, online (mocked iNat + GBIF)', { mocks: { 'api.inaturalist.org/v1/observations/species_counts': inatMock, 'api.gbif.org': gbifMock } });
if (!r.live.got) { console.log('  (fake audio capture delivered no signal — retrying with the getUserMedia override fallback)');
  r = await recordOnce('getUserMedia override, online', { mocks: { 'api.inaturalist.org/v1/observations/species_counts': inatMock, 'api.gbif.org': gbifMock }, fakeFile: false }); }
check(r.errors.length === 0, `no page errors ${r.errors.length ? JSON.stringify(r.errors) : ''}`);
check(r.live.kind === 'worklet', `raw PCM captured through the AudioWorklet tap (got: ${r.live.kind})`);
check(r.live.got && r.live.n > 2 * r.live.fs, 'non-silent capture longer than 2 s');
check(r.res.cards.length === 3, 'three result cards rendered');
check(r.res.cards.some(c => c.n === bird.n), `${bird.n} among the top 3`);
check(r.res.cards[0]?.n === bird.n, `${bird.n} ranked first`);
check(/iNaturalist/.test(r.res.meta || ''), 'occurrence prior (iNaturalist) used and reported');
check(/records nearby/.test(r.res.cards.find(c => c.n === bird.n)?.badge || ''), 'quantitative occurrence badge on the true species');
check(Math.abs((r.res.a?.peak || 0) / voc.truth.f - 1) < 0.08, `measured peak ${r.res.a?.peak?.toFixed(0)} Hz within 8 % of the synthesised ${voc.truth.f.toFixed(0)} Hz (FM notes)`);

const off = await recordOnce('fake microphone, OFFLINE (every request fails)', { mocks: {}, fakeFile: r.live.kind === 'worklet' || r.live.got });
check(off.errors.length === 0, 'offline: no page errors');
check(off.res.cards.length === 3 && off.res.cards.some(c => c.n === bird.n), `offline: still classifies, ${bird.n} in the top 3 (region prior)`);
check(/prior: N & C America/.test(off.res.meta || ''), 'offline: falls back to the region prior and says so');
check(Math.abs(off.res.a.snr - r.res.a.snr) < 3, `SNR estimate stable across runs despite digital-silence padding (${r.res.a.snr.toFixed(1)} vs ${off.res.a.snr.toFixed(1)} dB)`);

// Tap exactness: an OfflineAudioContext renders a known signal through the same tap.
{
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const app = await openApp(browser);
  const ex = await app.page.evaluate(async () => {
    const fs = 48000, n = 4096 * 24, ctx = new OfflineAudioContext(1, n, fs), b = ctx.createBuffer(1, n, fs), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.0137) * 0.5 + ((i * 7919) % 1000) / 4000 - 0.125;
    b.copyToChannel(x, 0); const src = ctx.createBufferSource(); src.buffer = b;
    const got = []; const tap = await captureTap(ctx, src, c => got.push(c)); src.start(); await ctx.startRendering();
    await new Promise(r => setTimeout(r, 300));
    const y = new Float32Array(got.reduce((s, c) => s + c.length, 0)); let o = 0; for (const c of got) { y.set(c, o); o += c.length; }
    let maxErr = 0; for (let i = 0; i < Math.min(n, y.length); i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    return { kind: tap.kind, n, captured: y.length, maxErr };
  });
  console.log(`\n[tap exactness] ${ex.kind}: captured ${ex.captured}/${ex.n} samples, max |error| ${ex.maxErr}`);
  check(ex.kind === 'worklet' && ex.captured === ex.n && ex.maxErr === 0, 'AudioWorklet tap is bit-exact and loses no samples');
  await app.close(); await browser.close();
}
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} check(s) FAILED` : '\nend-to-end capture OK ✓');
process.exit(fail ? 1 : 0);
