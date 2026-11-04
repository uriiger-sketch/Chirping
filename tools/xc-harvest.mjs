// xeno-canto harvester — measures REAL recordings of every catalogue species with the app's own
// analyzePCM (and the preserved v3.2 front-end, for comparison), and keeps only the measurements.
// Audio is decoded in Chromium, analysed in 8 s windows (a typical app clip), and discarded; the
// committed output is data/xc-features.jsonl (one line per recording) + docs/xc-attribution.md.
//
//   XC_API_KEY=… node tools/xc-harvest.mjs --preflight      # check key, API, decode, live iNat/GBIF
//   XC_API_KEY=… node tools/xc-harvest.mjs [--per 10] [--species "Turdus migratorius,…"]
//                [--out data/xc-features.jsonl] [--attribution docs/xc-attribution.md]
//
// Resumable (recordings already in --out are skipped). Polite: ≤1 API request/s, one download at a
// time with retries. XC_BASE overrides https://xeno-canto.org (used by tests/harvest-selftest.mjs).
// Selection and window rules: .claude/skills/bird-acoustic-data ("Measuring the catalogue").
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadPlaywright, chromiumPath, openApp, ROOT } from '../tests/lib/harness.mjs';
import { loadApp } from '../tests/lib/app-node.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const PER = +(args.per || 10), OUT = resolve(ROOT, args.out || 'data/xc-features.jsonl'), ATTR = resolve(ROOT, args.attribution || 'docs/xc-attribution.md');
const BASE = (process.env.XC_BASE || 'https://xeno-canto.org').replace(/\/$/, ''), KEY = process.env.XC_API_KEY;
const WIN_SEC = 8, MAX_WIN = 6, MIN_LEN = 5, MAX_LEN = 120, MAX_PER_RECORDIST = 2;
const log = (...a) => console.error(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!KEY) { log('XC_API_KEY is not set. xeno-canto API v3 needs a (free) key: https://xeno-canto.org/account → API key.'); process.exit(2); }
const { BIRD_DB } = loadApp();

// ── xeno-canto API v3 ──────────────────────────────────────────────────────────
let lastCall = 0;
async function api(query, page = 1) {
  const wait = lastCall + 1100 - Date.now(); if (wait > 0) await sleep(wait); lastCall = Date.now();
  const url = `${BASE}/api/3/recordings?query=${encodeURIComponent(query)}&key=${encodeURIComponent(KEY)}&per_page=100&page=${page}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.error) { const e = new Error(`xeno-canto API ${r.status}: ${j?.error?.message || j?.message || 'bad response'}`); e.fatal = r.status === 401 || r.status === 403; throw e; }
      return j;
    } catch (e) { if (e.fatal || attempt >= 3) throw e; await sleep(2000 * 2 ** attempt); }
  }
}
const lenSec = l => { const p = String(l || '0').split(':').map(Number); return p.reduce((s, v) => s * 60 + v, 0); };
const norm = s => String(s || '').toLowerCase().trim();

// Candidate recordings for a catalogue species (its name, then its synonyms), quality A then B.
async function candidates(b) {
  const out = new Map();
  for (const name of [b.s, ...(b.sy || [])]) {
    const [g, e] = name.split(' ');
    for (const q of ['A', 'B']) {
      const j = await api(`gen:${g} sp:${e} q:${q}`);
      for (const r of j.recordings || []) if (norm(r.gen) === norm(g) && norm(r.sp) === norm(e)) out.set(String(r.id), r);
      if ([...out.values()].filter(r => lenSec(r.length) >= MIN_LEN && lenSec(r.length) <= MAX_LEN).length >= 4 * PER) return [...out.values()];
    }
    if (out.size >= PER) break;
  }
  return [...out.values()];
}

// Rank: quality, no background species, vocalisation type matching the catalogue reference
// (song for whistled / trilled / warbled species), then a seeded shuffle; pick with at most
// MAX_PER_RECORDIST per recordist, one per country first, then fill.
function select(b, recs, have) {
  let h = 2166136261; for (const c of b.s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296);
  const wantSong = ['w', 't', 'c'].includes(b.t);
  const ok = recs.filter(r => { const L = lenSec(r.length); return L >= MIN_LEN && L <= MAX_LEN && !have.has(String(r.id)); });
  const key = r => [r.q === 'A' ? 0 : 1, (r.also || []).filter(Boolean).length ? 1 : 0, wantSong && !/song/i.test(r.type || '') ? 1 : 0];
  const ranked = ok.map(r => ({ r, k: key(r), u: rnd() })).sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.k[2] - y.k[2] || x.u - y.u).map(x => x.r);
  const perRec = new Map(), countries = new Set(), pick = [];
  for (const pass of [0, 1]) for (const r of ranked) {
    if (pick.length >= PER) break;
    if (pick.includes(r) || (perRec.get(r.rec) || 0) >= MAX_PER_RECORDIST || (pass === 0 && countries.has(r.cnt))) continue;
    pick.push(r); perRec.set(r.rec, (perRec.get(r.rec) || 0) + 1); countries.add(r.cnt);
  }
  return pick;
}

async function download(r) {
  const url = r.file?.startsWith('//') ? 'https:' + r.file : r.file?.startsWith('http') ? r.file : `${BASE}/${r.id}/download`;
  for (let attempt = 0; ; attempt++) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (!res.ok) throw new Error(`download ${res.status}`); return Buffer.from(await res.arrayBuffer()); }
    catch (e) { if (attempt >= 3) throw e; await sleep(2000 * 2 ** attempt); }
  }
}

// ── in-page measurement ────────────────────────────────────────────────────────
const r1 = x => Math.round(x * 10) / 10, r4 = x => Math.round(x * 1e4) / 1e4;
async function measureInPage(page, id, smp) {
  return page.evaluate(async ({ id, smp, WIN_SEC, MAX_WIN }) => {
    const buf = await (await fetch(`http://xc-audio.local/${id}`)).arrayBuffer();
    const ab = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
    const fs = ab.sampleRate, n = ab.length, x = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / ab.numberOfChannels; }
    // Files resampled up from a low original rate carry nothing above 0.45·smp: analyse only that band.
    const bwHz = smp && smp < 2.2 * 12000 ? 0.45 * smp : undefined, W = Math.round(WIN_SEC * fs), wins = [];
    for (let s = 0; s + 3 * fs <= n; s += W) {
      const w = x.subarray(s, Math.min(n, s + W)), a = analyzePCM(w, fs, { bwHz });
      if (!a.silent && a.peaks.length && a.f5) wins.push({ t0: s / fs, a, w });
    }
    wins.sort((p, q) => q.a.snrDb - p.a.snrDb);
    const out = [];
    for (const { t0, a, w } of wins.slice(0, MAX_WIN)) {
      const L = LegacyChirping, lf = L.computeFeatures(await L.legacyFrames(w, fs));
      out.push({ t0, a: { peaks: a.peaks.map(p => [p.hz, p.share]), f: [a.f5, a.f25, a.f50, a.f75, a.f95], c1: a.conc1, c3: a.conc3, iqr: a.pitchIQR, nr: a.noteRate, snr: a.snrDb, act: a.activeFrac, wind: a.windFrac },
        l: { peaks: lf.peaks.map(p => [p.hz, p.amp]), peak: lf.peak, cen: lf.centroid, sig: lf.signal, act: lf.activeRatio, pmax: lf.peakMaxAmp, ptot: lf.peakTotalAmp, bw: lf.bandwidth, dur: lf.duration } });
    }
    return { dur: n / fs, fs, nWin: wins.length, out };
  }, { id, smp, WIN_SEC, MAX_WIN });
}
function compact(w) {
  const a = w.a, l = w.l;
  return { t0: r1(w.t0), v4: { pk: a.peaks.map(([h, s]) => [r1(h), r4(s)]), f: a.f.map(v => Math.round(v)), c1: r4(a.c1), c3: r4(a.c3), iqr: a.iqr == null ? null : r4(a.iqr), nr: a.nr == null ? null : r4(a.nr), snr: Math.round(a.snr * 100) / 100, act: r4(a.act), wind: r4(a.wind) },
    v32: { pk: l.peaks.map(([h, m]) => [Math.round(h), r4(m)]), peak: l.peak, cen: l.cen, sig: r4(l.sig), act: r4(l.act), pmax: r4(l.pmax), ptot: r4(l.ptot), bw: l.bw, dur: l.dur } };
}

// ── main ───────────────────────────────────────────────────────────────────────
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const app = await openApp(browser, { legacy: true, allow: args.preflight ? ['api.inaturalist.org', 'api.gbif.org'] : [] });
const audio = new Map();
await app.page.route('http://xc-audio.local/**', route => { const id = route.request().url().split('/').pop(); const b = audio.get(id); return b ? route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: b }) : route.abort(); });

if (args.preflight) {
  let fail = 0; const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++; };
  console.log('Preflight');
  ok(!!KEY, 'XC_API_KEY present');
  let rec;
  try { const j = await api('gen:Turdus sp:migratorius q:A'); rec = j.recordings?.[0];
    ok(j.numRecordings > 0 && rec, `xeno-canto API v3 answers (numRecordings ${j.numRecordings}); fields: ${rec ? Object.keys(rec).join(',') : '—'}`);
  } catch (e) { ok(false, `xeno-canto API: ${e.message}`); }
  if (rec) try { audio.set(String(rec.id), await download(rec)); const m = await measureInPage(app.page, String(rec.id), +rec.smp);
    ok(m.out.length > 0, `XC${rec.id} downloaded, decoded (${m.dur.toFixed(1)} s @ ${m.fs} Hz) and measured: ${m.out.length} windows, peak ${m.out[0]?.a.peaks[0]?.[0].toFixed(0)} Hz`);
  } catch (e) { ok(false, `download/decode: ${e.message}`); }
  for (const [lat, lon, where] of [[40.71, -74.0, 'New York'], [51.5, -0.12, 'London'], [-33.87, 151.21, 'Sydney']]) {
    const o = await app.page.evaluate(async ([lat, lon]) => { const occ = await fetchOccurrence(lat, lon); const g = await gbifCounts(['Turdus migratorius', 'Turdus merula'], lat, lon).catch(e => ({ err: String(e) }));
      return { n: occ?.nSpecies, total: occ?.total, top: occ && Object.entries(occ.counts).sort((a, b) => b[1] - a[1]).slice(0, 3), gbif: g.counts || g.err }; }, [lat, lon]);
    ok(o.n >= 20 && Array.isArray(o.gbif) && o.gbif.some(c => c !== null), `live occurrence prior, ${where}: iNat ${o.n} species / ${o.total} obs (top ${JSON.stringify(o.top)}), GBIF counts ${JSON.stringify(o.gbif)}`);
  }
  await app.close(); await browser.close(); process.exit(fail ? 1 : 0);
}

const done = new Map(); // species → Set of xc ids already measured
if (existsSync(OUT)) for (const line of readFileSync(OUT, 'utf8').split('\n')) { if (!line.trim()) continue; const r = JSON.parse(line); if (!done.has(r.s)) done.set(r.s, new Set()); done.get(r.s).add(String(r.xc)); }
mkdirSync(dirname(OUT), { recursive: true });
const only = args.species ? new Set(String(args.species).split(',').map(s => s.trim())) : null;
const stats = { species: 0, recordings: 0, windows: 0, short: [], failures: [], fatal: null };
const t0 = Date.now();
for (const b of BIRD_DB) {
  if (only && !only.has(b.s)) continue;
  const have = done.get(b.s) || new Set();
  if (have.size >= PER) { stats.species++; continue; }
  let picks;
  try { picks = select({ ...b }, await candidates(b), have).slice(0, PER - have.size); }
  catch (e) { if (e.fatal) { log(`\nfatal: ${e.message}`); stats.fatal = e.message; break; } stats.failures.push(`${b.s}: ${e.message}`); continue; }
  let got = have.size;
  for (const r of picks) {
    try {
      audio.set(String(r.id), await download(r));
      const m = await measureInPage(app.page, String(r.id), +r.smp);
      audio.delete(String(r.id));
      if (!m.out.length) { stats.failures.push(`XC${r.id} (${b.s}): no usable window`); continue; }
      const row = { xc: +r.id, s: b.s, gen: r.gen, sp: r.sp, en: r.en, rec: r.rec, cnt: r.cnt, lat: r.lat == null ? null : +r.lat, lon: (r.lon ?? r.lng) == null ? null : +(r.lon ?? r.lng),
        date: r.date, type: r.type, q: r.q, len: lenSec(r.length), lic: r.lic, smp: +r.smp || null, also: (r.also || []).filter(Boolean), dur: Math.round(m.dur * 10) / 10, win: m.out.map(compact) };
      appendFileSync(OUT, JSON.stringify(row) + '\n');
      got++; stats.recordings++; stats.windows += row.win.length;
    } catch (e) { audio.delete(String(r.id)); stats.failures.push(`XC${r.id} (${b.s}): ${e.message}`); }
  }
  stats.species++; if (got < PER) stats.short.push(`${b.n} (${got})`);
  log(`  ${String(stats.species).padStart(3)}/${only ? only.size : BIRD_DB.length} ${b.n.padEnd(30)} ${got}/${PER} recordings   [${((Date.now() - t0) / 60000).toFixed(1)} min]`);
}
await app.close(); await browser.close();

// Attribution for every recording measured so far (CC licences require it even for derived data).
if (existsSync(OUT)) {
  const rows = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const md = ['# xeno-canto recordings measured for the Chirping catalogue', '',
    'Measurements (not audio) derived from these recordings are in `data/xc-features.jsonl`. Each recording',
    'remains © its recordist under the licence shown; see https://xeno-canto.org for the originals.', '',
    '| XC | species | recordist | country | licence |', '|---|---|---|---|---|',
    ...rows.map(r => `| [XC${r.xc}](https://xeno-canto.org/${r.xc}) | ${r.gen} ${r.sp} | ${String(r.rec).replace(/\|/g, '/')} | ${r.cnt || ''} | ${r.lic ? `[${r.lic.replace(/^.*licenses\//, '').replace(/\/$/, '')}](${r.lic.startsWith('//') ? 'https:' + r.lic : r.lic})` : ''} |`)];
  mkdirSync(dirname(ATTR), { recursive: true }); writeFileSync(ATTR, md.join('\n') + '\n');
}
console.log(`\nspecies processed ${stats.species}, recordings measured ${stats.recordings}, windows ${stats.windows}`);
if (stats.short.length) console.log(`fewer than ${PER} usable recordings: ${stats.short.join(', ')}`);
if (stats.failures.length) console.log(`failures (${stats.failures.length}):\n  ${stats.failures.slice(0, 40).join('\n  ')}`);
if (stats.fatal) { console.log(`stopped: ${stats.fatal}`); process.exit(1); }
