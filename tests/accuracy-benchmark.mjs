// Chirping accuracy benchmark — runs the REAL app code (computeFeatures, scoreSpecies,
// classifyBirds) in a headless browser against synthetic-but-realistic bird calls for
// every species in BIRD_DB, and reports how often the algorithm ranks the true species
// correctly. This is a self-recognition test, not ground truth from real audio — it
// measures whether the scoring math is internally consistent and well-tuned, not
// whether the underlying species frequency data matches real birds in the wild.
//
// Usage:
//   npx http-server -p 8902 -s -c-1 &   (serve the repo root)
//   node tests/accuracy-benchmark.mjs [http://127.0.0.1:8902/index.html]
//
// What makes this more than a smoke test:
//   - TRIALS synthetic draws per species (not one), reporting mean AND best-case,
//     because a single random draw is noisy and best-of-N alone is optimistic.
//   - Three noise conditions (clean / moderate / noisy) so a config that only works
//     in ideal conditions doesn't look artificially strong.
//   - Both global (no location) and region-filtered (location on, the app default)
//     accuracy, since region filtering is doing real work in production.
//   - A confusion report: which species are most often mistaken for which, so DB
//     curation effort goes where it actually matters instead of guessing.

import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8902/index.html';
const TRIALS = 8;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(800);

const report = await page.evaluate((TRIALS) => {
  S.hzPerBin = 107.666; // realistic 44100 Hz device
  const H = S.hzPerBin;

  function addPeak(fr, hz, amp) {
    const bin = Math.round(hz / H);
    for (let d = -2; d <= 2; d++) { const b = bin + d; if (b >= 0 && b < FREQ_BINS) fr[b] += amp * Math.exp(-d * d / 2); }
  }

  // noiseLevel: 'clean' | 'moderate' | 'noisy' — scales background floor + jitter,
  // simulating recording conditions from a quiet garden to a windy street.
  function synthFrames(bird, noiseLevel) {
    const { fdom, fmin, fmax } = bird;
    const bw = Math.max(200, fmax - fmin);
    const noiseFloor = { clean: 0.015, moderate: 0.03, noisy: 0.06 }[noiseLevel];
    const jitterScale = { clean: 1, moderate: 1.5, noisy: 2.2 }[noiseLevel];
    const n = 300, activeFrac = 0.3;
    const frames = [];
    for (let f = 0; f < n; f++) {
      const fr = new Float32Array(FREQ_BINS);
      for (let i = 0; i < FREQ_BINS; i++) fr[i] = noiseFloor * 0.5 + Math.random() * noiseFloor;
      if (f % 10 < activeFrac * 10) {
        const jitter = (Math.random() - 0.5) * 2 * Math.min(60, bw * 0.05) * jitterScale;
        addPeak(fr, fdom + jitter, 0.55);
        const numSub = 1 + Math.round(bw / 1500);
        for (let k = 0; k < numSub; k++) {
          const hz = fmin + Math.random() * (fmax - fmin);
          addPeak(fr, hz, 0.15 + Math.random() * 0.15);
        }
      }
      frames.push(fr);
    }
    return frames;
  }

  function rankAndTop(sciName, feats, pool) {
    const scored = pool.map(b => ({ n: b.n, s: b.s, raw: scoreSpecies(feats, b) })).sort((a, b) => b.raw - a.raw);
    return { rank: scored.findIndex(b => b.s === sciName) + 1, winner: scored[0] };
  }

  function regionPoolFor(bird) {
    const reg = BIRD_DB.filter(b => b.r.includes(bird.r[0]));
    return reg.length >= 5 ? reg : BIRD_DB;
  }

  const noiseLevels = ['clean', 'moderate', 'noisy'];
  const confusions = {}; // trueName -> { winnerName -> count }

  function measure(useRegion, noiseLevel) {
    // bestOfN: could the algorithm ever find the species in TRIALS attempts (optimistic —
    // relevant only if a user records the same bird several times).
    // meanPerTrial: the fraction of INDIVIDUAL trials that succeeded — this is what a
    // real user experiences on any single recording, and is the number that matters most.
    let top1 = 0, top3 = 0, top5 = 0;
    let meanTop1 = 0, meanTop3 = 0, meanTop5 = 0;
    const N = BIRD_DB.length;
    for (const bird of BIRD_DB) {
      const pool = useRegion ? regionPoolFor(bird) : BIRD_DB;
      let bestRank = Infinity, trialsTop1 = 0, trialsTop3 = 0, trialsTop5 = 0;
      for (let t = 0; t < TRIALS; t++) {
        const feats = computeFeatures(synthFrames(bird, noiseLevel));
        const { rank, winner } = rankAndTop(bird.s, feats, pool);
        if (rank < bestRank) bestRank = rank;
        if (rank === 1) trialsTop1++;
        if (rank <= 3) trialsTop3++;
        if (rank <= 5) trialsTop5++;
        if (rank !== 1 && !useRegion && noiseLevel === 'moderate') {
          confusions[bird.n] = confusions[bird.n] || {};
          confusions[bird.n][winner.n] = (confusions[bird.n][winner.n] || 0) + 1;
        }
      }
      meanTop1 += trialsTop1 / TRIALS; meanTop3 += trialsTop3 / TRIALS; meanTop5 += trialsTop5 / TRIALS;
      if (bestRank === 1) top1++; if (bestRank <= 3) top3++; if (bestRank <= 5) top5++;
    }
    return {
      bestOfN: { top1: +(top1 / N * 100).toFixed(1), top3: +(top3 / N * 100).toFixed(1), top5: +(top5 / N * 100).toFixed(1) },
      meanPerTrial: { top1: +(meanTop1 / N * 100).toFixed(1), top3: +(meanTop3 / N * 100).toFixed(1), top5: +(meanTop5 / N * 100).toFixed(1) },
    };
  }

  const matrix = {};
  for (const noise of noiseLevels) {
    matrix[noise] = { global: measure(false, noise), regionFiltered: measure(true, noise) };
  }

  // Top confusions: species most often misidentified, and their most common wrong winner
  const topConfusions = Object.entries(confusions)
    .map(([truth, winners]) => {
      const [topWinner, count] = Object.entries(winners).sort((a, b) => b[1] - a[1])[0];
      return { truth, mostConfusedWith: topWinner, count, ofTrials: TRIALS };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return { dbSize: BIRD_DB.length, trials: TRIALS, matrix, topConfusions };
}, TRIALS);

console.log(`\n=== Chirping accuracy benchmark (${report.dbSize} species, ${report.trials} trials/condition) ===\n`);
if (pageErrors.length) console.log('PAGE ERRORS:', pageErrors);

for (const [noise, r] of Object.entries(report.matrix)) {
  console.log(`[${noise.toUpperCase()}]  (mean-per-trial = what a single real recording attempt experiences; best-of-N = repeated attempts)`);
  console.log(`  global          mean: top1=${r.global.meanPerTrial.top1}%  top3=${r.global.meanPerTrial.top3}%  top5=${r.global.meanPerTrial.top5}%   |  best-of-${TRIALS}: top1=${r.global.bestOfN.top1}%  top3=${r.global.bestOfN.top3}%  top5=${r.global.bestOfN.top5}%`);
  console.log(`  region-filtered mean: top1=${r.regionFiltered.meanPerTrial.top1}%  top3=${r.regionFiltered.meanPerTrial.top3}%  top5=${r.regionFiltered.meanPerTrial.top5}%   |  best-of-${TRIALS}: top1=${r.regionFiltered.bestOfN.top1}%  top3=${r.regionFiltered.bestOfN.top3}%  top5=${r.regionFiltered.bestOfN.top5}%`);
}

console.log(`\nTop confusions (global, moderate noise) — species most often mistaken for another:`);
for (const c of report.topConfusions) {
  console.log(`  ${c.truth.padEnd(28)} → mistaken for ${c.mostConfusedWith.padEnd(28)} in ${c.count}/${c.ofTrials} trials`);
}

await browser.close();
process.exit(pageErrors.length ? 1 : 0);
