// Shared access to the real-recording measurements (data/xc-features.jsonl, written by
// tools/xc-harvest.mjs): reading, the recordist-disjoint train/test split, and conversion of the
// stored compact windows back into the objects the app's scorer and the v3.2 scorer consume.
import { readFileSync, existsSync } from 'node:fs';

export function readFeatures(path) {
  if (!existsSync(path)) throw new Error(`${path} not found — run tools/xc-harvest.mjs first`);
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// Per species: hold out whole RECORDISTS (an individual bird or a recordist's equipment must not
// appear on both sides) until ≥ `test` recordings are held out, keeping ≥ 2 for fitting.
// Deterministic in (species, recordists, seed).
export function split(rows, { test = 3, seed = 20261030 } = {}) {
  const bySp = new Map();
  for (const r of rows) { if (!bySp.has(r.s)) bySp.set(r.s, []); bySp.get(r.s).push(r); }
  const role = new Map();
  for (const [s, recs] of bySp) {
    let h = seed >>> 0; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => ((h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x6D2B79F5) >>> 0) / 4294967296);
    const people = [...new Set(recs.map(r => r.rec))].map(p => [p, rnd()]).sort((a, b) => a[1] - b[1]).map(p => p[0]);
    let held = 0; const testers = new Set();
    for (const p of people) {
      if (held >= test) break;
      const k = recs.filter(r => r.rec === p).length;
      if (recs.length - held - k < 2) continue;
      testers.add(p); held += k;
    }
    for (const r of recs) role.set(r.xc, testers.has(r.rec) ? 'test' : 'train');
  }
  return { role, train: rows.filter(r => role.get(r.xc) === 'train'), test: rows.filter(r => role.get(r.xc) === 'test') };
}

// Stored v4 window → the analysis object posterior() expects.
export const toAnalysis = v => ({ peaks: v.pk.map(([hz, share]) => ({ hz, share })), f5: v.f[0], f25: v.f[1], f50: v.f[2], f75: v.f[3], f95: v.f[4],
  conc1: v.c1, conc3: v.c3, pitchIQR: v.iqr, noteRate: v.nr, snrDb: v.snr, activeFrac: v.act, windFrac: v.wind });
// Stored v3.2 window → the feats object the verbatim v3.2 scoreSpecies() expects.
export const toLegacy = l => ({ peaks: l.pk.map(([hz, amp]) => ({ hz, amp })), peak: l.peak, centroid: l.cen, signal: l.sig, activeRatio: l.act,
  peakMaxAmp: l.pmax, peakTotalAmp: l.ptot, bandwidth: l.bw, duration: l.dur });
