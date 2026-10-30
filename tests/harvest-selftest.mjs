// Plumbing self-test for the real-audio pipeline: a MOCK xeno-canto archive (API v3 shape, WAV
// "recordings" rendered by tests/lib/synth.js) is harvested, fitted and benchmarked end to end in
// a temp directory. It proves the tools work — selection rules, decoding, windowing, resumability,
// auth failure, fitting, write-back, evaluation — and measures NOTHING about real birds.
//
//   node tests/harvest-selftest.mjs
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './lib/harness.mjs';
import { loadApp } from './lib/app-node.mjs';

// Plain evaluation (not vm): a vm sandbox makes every global lookup slow, and synthesis is hot code.
const sb = new Function(`${readFileSync(join(ROOT, 'tests/lib/synth.js'), 'utf8')}\nreturn globalThis;`)();
const Sy = sb.ChirpSynth, { BIRD_DB } = loadApp(), FS = 44100;

function wav16(x, fs) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + 2 * i);
  return b;
}

// One species per vocal type; 7 candidate recordings each (recordist "Ann" thrice, to exercise the
// at-most-2-per-recordist rule), quality A except one B.
const species = ['w', 'h', 'n', 't', 'c', 'p'].map(t => BIRD_DB.find(b => b.t === t)).filter(Boolean);
const people = ['Ann', 'Ann', 'Ann', 'Bob', 'Cai', 'Dee', 'Eve'], countries = ['Norway', 'Peru', 'Japan', 'Kenya'];
const recs = [], audio = new Map(), truth = new Map();
let id = 900000;
for (const b of species) for (let k = 0; k < people.length; k++) {
  const seed = id * 7 + 1, v1 = Sy.vocalisation(b, seed, { fs: FS, seconds: 6 }), v2 = Sy.vocalisation(b, seed + 3, { fs: FS, seconds: 6 });
  const pcm = Float64Array.from([...v1.pcm, ...v2.pcm]), noise = Sy.fieldNoise(seed + 9, FS, pcm.length, { traffic: 0.2 });
  const x = Sy.mix({ pcm, fs: FS, truth: { ...v1.truth, t1: 6 + v2.truth.t1 } }, noise, 15, 0.3);
  const [g, e] = b.s.split(' ');
  recs.push({ id: String(id), gen: g, sp: e, en: b.n, rec: people[k], cnt: countries[k % 4], lat: '40.7', lon: '-74.0', type: ['w', 't', 'c'].includes(b.t) ? 'song' : 'call',
    q: k === 6 ? 'B' : 'A', length: '0:12', lic: '//creativecommons.org/licenses/by-nc-sa/4.0/', also: [], smp: String(FS), date: '2024-05-12', file: '' });
  audio.set(String(id), wav16(x, FS)); truth.set(String(id), v1.truth.f); id++;
}
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/3/recordings') {
    if (u.searchParams.get('key') !== 'test') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized', message: 'invalid key' } })); return; }
    const q = u.searchParams.get('query'), m = q.match(/gen:(\S+) sp:(\S+) q:(\S)/);
    const hit = m ? recs.filter(r => r.gen === m[1] && r.sp === m[2] && r.q === m[3]) : [];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ numRecordings: String(hit.length), numSpecies: '1', page: 1, numPages: 1, recordings: hit }));
    return;
  }
  const d = u.pathname.match(/^\/(\d+)\/download$/);
  if (d && audio.has(d[1])) { res.writeHead(200, { 'content-type': 'audio/wav' }).end(audio.get(d[1])); return; }
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'chirping-harvest-')), feat = join(dir, 'feat.jsonl'), attr = join(dir, 'attr.md');
// Async spawn: the mock archive lives in THIS process, so a synchronous spawn would deadlock it.
const run = (script, extra, env = {}) => new Promise(done => {
  const c = spawn(process.execPath, [join(ROOT, script), ...extra], { env: { ...process.env, XC_BASE: BASE, ...env } });
  let stdout = '', stderr = ''; c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
  const kill = setTimeout(() => c.kill('SIGKILL'), 600000); c.on('close', status => { clearTimeout(kill); done({ status, stdout, stderr }); });
});

let fail = 0; const check = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fail++; };
console.log('=== Real-audio pipeline self-test (mock archive of SYNTHETIC recordings — plumbing only) ===');
const list = species.map(b => b.s).join(',');

const bad = await run('tools/xc-harvest.mjs', ['--per', '6', '--species', list, '--out', feat, '--attribution', attr], { XC_API_KEY: 'wrong' });
check(bad.status === 1 && /invalid key/.test(bad.stdout + bad.stderr), 'harvest stops with a clear error on a rejected API key');

const h = await run('tools/xc-harvest.mjs', ['--per', '6', '--species', list, '--out', feat, '--attribution', attr], { XC_API_KEY: 'test' });
if (h.status !== 0) console.log(h.stdout, h.stderr);
const rows = existsSync(feat) ? readFileSync(feat, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
check(h.status === 0 && rows.length === species.length * 6, `harvest measured ${rows.length}/${species.length * 6} recordings (6 per species)`);
const perRec = {}; for (const r of rows) perRec[r.s + r.rec] = (perRec[r.s + r.rec] || 0) + 1;
check(Object.values(perRec).every(n => n <= 2), 'at most 2 recordings per recordist per species');
check(rows.every(r => r.win.length >= 1 && r.win.length <= 6), 'every recording has 1–6 analysed windows');
const close = rows.filter(r => Math.abs(Math.log(r.win[0].v4.pk[0][0] / truth.get(String(r.xc)))) < 0.15).length;
check(close >= 0.8 * rows.length, `measured peak within 15 % of the synthesised pitch for ${close}/${rows.length} recordings`);
check(rows.every(r => r.win[0].v32 && Array.isArray(r.win[0].v32.pk)), 'v3.2 features stored alongside for every window');
check(existsSync(attr) && readFileSync(attr, 'utf8').split('\n').filter(l => l.startsWith('| [XC')).length === rows.length, 'attribution table lists every measured recording');
const again = await run('tools/xc-harvest.mjs', ['--per', '6', '--species', list, '--out', feat, '--attribution', attr], { XC_API_KEY: 'test' });
check(again.status === 0 && readFileSync(feat, 'utf8').split('\n').filter(Boolean).length === rows.length, 'resumable: a second run adds nothing');

const html = join(dir, 'index.html'), prov = join(dir, 'prov.json');
copyFileSync(join(ROOT, 'index.html'), html); copyFileSync(join(ROOT, 'docs/bird-db-provenance.json'), prov);
const f = await run('tools/fit-model.mjs', ['--features', feat, '--write', '--html', html, '--prov', prov]);
if (f.status !== 0) console.log(f.stdout, f.stderr);
check(f.status === 0 && /fitted \d+\/\d+ species/.test(f.stdout), `fit-model ran (${(f.stdout.match(/fitted \d+\/\d+ species[^\n]*/) || ['—'])[0]})`);
const fitted = loadApp(readFileSync(html, 'utf8')).BIRD_DB.filter(b => species.some(s => s.s === b.s));
check(fitted.every(b => b.x && b.c === 'd' && b.cf === 'd' && b.fmin < b.fdom && b.fdom < b.fmax), 'write-back: every harvested species now carries measured parameters (x, c/cf = d)');
const lint = await run('tests/db-lint.mjs', [html]);
check(lint.status === 0, 'the fitted catalogue passes db-lint (incl. the measured-entry rules)');
const f2 = await run('tools/fit-model.mjs', ['--features', feat, '--html', html, '--prov', prov]);
check(f2.status === 0 && f.stdout.split('fitted')[0].replace(/\d+ms/g, '') === f2.stdout.split('fitted')[0].replace(/\d+ms/g, ''), 'fit is deterministic (identical CV report on rerun)');

const bm = await run('tests/real-benchmark.mjs', ['--features', feat]);
if (bm.status !== 0) console.log(bm.stdout, bm.stderr);
check(bm.status === 0 && /v4\.1 {2}region/.test(bm.stdout), 'real-benchmark scores held-out recordists for v3.2 / v4.0 / v4.1');
server.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} check(s) FAILED` : '\nreal-audio pipeline plumbing OK ✓ (synthetic data — no real-world claim)');
process.exit(fail ? 1 : 0);
