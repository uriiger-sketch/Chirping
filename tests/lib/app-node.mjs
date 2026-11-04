// Load the app's own catalogue, DSP and scoring code from index.html into Node — the exact
// functions the browser runs (no copy to drift). Used by tools/fit-model.mjs and
// tests/real-benchmark.mjs, which work from stored measurements and need no browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INDEX = fileURLToPath(new URL('../../index.html', import.meta.url));
const START = '// ── Calibrated bioacoustic DSP', END = '// ── Images: Wikipedia';

export function catalogueSource(html) {
  const m = html.match(/const BIRD_DB = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('BIRD_DB not found');
  return m[1];
}

// Returns {BIRD_DB, DSP, MODEL, analyzePCM, createAnalyzer, featureVector, logLik, posterior,
// regionPrior, getRegions, makePrior, occCount, OCC}. `html` defaults to the current index.html.
export function loadApp(html = readFileSync(INDEX, 'utf8')) {
  const a = html.indexOf(START), b = html.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error('analysis section markers not found in index.html');
  const src = `const BIRD_DB=${catalogueSource(html)};\n${html.slice(a, b)}\n` +
    'return {BIRD_DB,DSP,MODEL,analyzePCM,createAnalyzer,featureVector,logLik,posterior,regionPrior,getRegions,makePrior,occCount,OCC};';
  return new Function(src)();
}
