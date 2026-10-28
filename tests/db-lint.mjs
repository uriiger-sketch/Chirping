// BIRD_DB lint — structural and physical invariants of the species catalogue, plus a degeneracy
// report (how many species a classifier could not tell apart even with perfect measurements).
// Node only, no browser:  node tests/db-lint.mjs
// Rules behind each check: .claude/skills/bird-acoustic-data/SKILL.md

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const m = html.match(/const BIRD_DB = (\[[\s\S]*?\n\]);/);
if (!m) { console.error('BIRD_DB not found in index.html'); process.exit(1); }
const DB = new Function(`return ${m[1]}`)();

const REGIONS = new Set(['na', 'sa', 'eu', 'as', 'af', 'au']);
const TYPES = new Set(['w', 'h', 'n', 't', 'c', 'p']);
const CONF = new Set(['h', 'm', 'l']);
const BINOMIAL = /^[A-Z][a-z]+ [a-z][a-z-]+$/;
const errors = [];
const err = (b, msg) => errors.push(`${b.n || '?'} (${b.s || '?'}): ${msg}`);

const seenN = new Map(), seenS = new Map();
for (const b of DB) {
  for (const k of ['n', 's', 'h', 'f', 'w']) if (typeof b[k] !== 'string' || !b[k].trim()) err(b, `missing text field ${k}`);
  if (!BINOMIAL.test(b.s)) err(b, `scientific name is not a binomial: "${b.s}"`);
  if (seenN.has(b.n)) err(b, 'duplicate common name'); seenN.set(b.n, b);
  if (seenS.has(b.s)) err(b, 'duplicate scientific name'); seenS.set(b.s, b);
  for (const k of ['fmin', 'fmax', 'fdom']) if (!Number.isFinite(b[k])) err(b, `${k} not a number`);
  if (!(b.fmin < b.fdom && b.fdom < b.fmax)) err(b, `need fmin < fdom < fmax, got ${b.fmin}/${b.fdom}/${b.fmax}`);
  if (b.fmin < 50 || b.fmax > 16000) err(b, `frequency outside 50 Hz–16 kHz: ${b.fmin}–${b.fmax}`);
  if (b.fmax / b.fmin < 1.2) err(b, `band narrower than a minor third (${b.fmin}–${b.fmax}) — implausible for a song`);
  if (!Array.isArray(b.r) || !b.r.length || !b.r.every(r => REGIONS.has(r))) err(b, `bad region codes ${JSON.stringify(b.r)}`);
  if (new Set(b.r).size !== b.r.length) err(b, 'duplicate region code');
  if (!TYPES.has(b.t)) err(b, `bad vocal type ${JSON.stringify(b.t)}`);
  if (b.nr !== null && !(Array.isArray(b.nr) && b.nr.length === 2 && b.nr[0] > 0 && b.nr[0] <= b.nr[1] && b.nr[1] <= 100))
    err(b, `nr must be null or [lo,hi] notes/s with 0<lo≤hi≤100, got ${JSON.stringify(b.nr)}`);
  if (!CONF.has(b.c) || !CONF.has(b.cf)) err(b, `confidence codes c/cf must be h|m|l, got ${b.c}/${b.cf}`);
  if (b.sy !== undefined && !(Array.isArray(b.sy) && b.sy.every(s => /^[A-Z][a-z]+ [a-z-]+( [a-z-]+)?$/.test(s) && s !== b.s)))
    err(b, `sy must list other binomials/trinomials: ${JSON.stringify(b.sy)}`);
}

// Degeneracy: two species are frequency-indistinguishable when peak frequencies differ by <5 %
// and band edges by <10 % (inside the measurement + intraspecific spread); descriptor-
// indistinguishable when additionally the vocal type matches and note-rate ranges overlap.
const near = (a, b) => Math.abs(Math.log(a.fdom / b.fdom)) < 0.05 && Math.abs(Math.log(a.fmin / b.fmin)) < 0.1 && Math.abs(Math.log(a.fmax / b.fmax)) < 0.1;
const nrOverlap = (a, b) => (a.nr === null && b.nr === null) || (a.nr && b.nr && a.nr[0] <= b.nr[1] && b.nr[0] <= a.nr[1]);
const twin = (a, b) => near(a, b) && a.t === b.t && nrOverlap(a, b);
// Top-1 ceiling with perfect measurements = (#equivalence classes)/(#species) under the relation.
function ceiling(pool, rel) {
  const parent = pool.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (rel(pool[i], pool[j])) parent[find(i)] = find(j);
  return new Set(pool.map((_, i) => find(i))).size / pool.length;
}
const pct = x => (x * 100).toFixed(1) + '%';
const sig = b => `${b.fmin}/${b.fmax}/${b.fdom}`;
const conf = k => ['h', 'm', 'l'].map(c => `${c}:${DB.filter(b => b[k] === c).length}`).join(' ');

console.log(`\n=== BIRD_DB lint (${DB.length} species) ===`);
console.log(`identical (fmin,fmax,fdom) signatures: ${DB.length - new Set(DB.map(sig)).size} duplicates; fdom on a 100 Hz grid: ${DB.filter(b => b.fdom % 100 === 0).length}`);
console.log(`confidence  descriptors c → ${conf('c')}   frequencies cf → ${conf('cf')}`);
console.log(`vocal types ${[...TYPES].map(t => `${t}:${DB.filter(b => b.t === t).length}`).join(' ')}`);
console.log(`top-1 ceiling with perfect measurement   frequency-only | +type & note rate`);
console.log(`  global  ${pct(ceiling(DB, near)).padStart(28)} | ${pct(ceiling(DB, twin))}`);
for (const r of REGIONS) {
  const pool = DB.filter(b => b.r.includes(r));
  console.log(`  ${r} (${String(pool.length).padStart(3)})${pct(ceiling(pool, near)).padStart(23)} | ${pct(ceiling(pool, twin))}`);
}
if (errors.length) { console.log(`\n${errors.length} invariant violation(s):`); errors.forEach(e => console.log('  ✗ ' + e)); process.exit(1); }
console.log('\nall invariants hold ✓');
