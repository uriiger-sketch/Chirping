# Chirping — physics & data-analysis audit (v3.2 → v4.0)

**Panel.** Three roles, each run as independent agents that read the code themselves:
- signal-processing physicist;
- ornithologist-bioacoustician (three agents, about 73 catalogue entries each);
- statistician.

Their checklists live in `.claude/skills/{bioacoustic-dsp,bird-acoustic-data,classifier-statistics,physics-audit}`.

**Evidence rule.** Every number below comes from code that was run in this audit: a known-truth test, the benchmark, or a computed statistic. Nothing is an estimate.

**Reproduce:**
```
node tests/db-lint.mjs
node tests/dsp-precision.mjs
node tests/e2e-capture.mjs
node tests/accuracy-benchmark.mjs
```
`npm test` runs all four.

## 1. Findings

### A. Signal chain (v3.2 `index.html`, render loop, `initAudio`, `computeFeatures`)

| # | Finding | Measured evidence | v4 status |
|---|---|---|---|
| A1 | The spectrum was **decimated by sample-picking**: `buf[i*step]` kept 1 of every 10 FFT bins. | Under the AnalyserNode's Blackman window, a steady tone loses >3 dB at 82 % of frequencies, >20 dB at 61 % and **>50 dB at 45 %**. At 0 dB SNR the old chain detected only 57 % of test tones. | Fixed. Analysis uses every bin of its own STFT. |
| A2 | **dB was treated as linear amplitude.** `getByteFrequencyData` (dB mapped to bytes, clipped at −30 dB) was summed, averaged and used for the centroid. Noise was subtracted as `f − 0.85·noise` in the log domain. | That subtraction is a ×0.15 gain on the log scale and leaves a pedestal across all 192 bins. On a 2.8 kHz robin song in moderate noise, v3.2 measured the peak at **703 Hz**. | Fixed. All arithmetic is on linear power. |
| A3 | **A DynamicsCompressor (on by default) and a 300 Hz high-pass sat in the analysis path.** | Time-varying gain and a filter cutting the owl/dove/pigeon band, where fdom is 300–400 Hz. | Fixed. A raw tap feeds the classifier; the filters shape only the picture. |
| A4 | **Resolution was quantised to ±54 Hz** (107.7 Hz bins, no interpolation). | Tone RMS error was **36–46 Hz** (max 105 Hz), measured on the same signals. | Fixed: **0.33–0.44 Hz** RMS, max 0.76 Hz. |
| A5 | **The clock was `requestAnimationFrame`** (60/120 Hz, stops when the screen locks). | `duration = frames/60`. No temporal features existed. | Fixed. Sample-clocked AudioWorklet, bit-exact (98 304 of 98 304 samples, error 0). |
| A6 | **The thresholds meant nothing physically.** | The silence gate `signal < 0.006` never fired, and the peak gates were applied on a dB scale. | Replaced by in-band SNR in dB, with activity hysteresis at 9/5 dB (0.0–0.1 % false activity on noise). |
| A7 | **`rebuildChain()` called `srcNode.disconnect()` with no argument**, which drops every outgoing connection. | Any added tap would be cut whenever a filter was toggled. | Fixed. The display branch hangs off `displayIn`. |
| A8 | **MediaRecorder blobs were recorded but never read.** | Lossy Opus/AAC; a 1.2 s watchdog. | Removed. |

### B. Statistics and scoring

| # | Finding | Evidence | v4 status |
|---|---|---|---|
| B1 | **Similarity was a linear-Hz Gaussian with σ = 700 Hz.** | ±117 % tolerance at 600 Hz but ±8 % at 8.5 kHz; pitch scatters multiplicatively. | Replaced by normalised log-frequency likelihoods. |
| B2 | **Confidence was not a probability.** Softmax T=4 over the top 10, then ×1.5 / ×1.35 / ×0.8 boosts, then **renormalisation over the top 3**. | The three cards always summed to 100 %. | Replaced by a posterior over the whole catalogue plus a not-in-catalogue class. Temperature-calibrated (ECE in §2); the remaining mass is shown. |
| B3 | **Occurrence evidence was a yes/no flag.** It came from the first 200 GBIF records or 100 iNat observations, with no season. | — | Replaced by an iNat `species_counts` prior (50 km, month ±1, cached for 7 days) and GBIF counts that re-weight only within the top-5 block. |
| B4 | **`getRegion` returned null** for southern Africa, Madagascar, Indonesia, Singapore, NZ and Iceland. It sent Israel to "af" and Hawaii to "na". | — | Fixed with overlapping realm boxes. The hard filter became a soft prior. |

### C. Data (`BIRD_DB`)

| # | Finding | Evidence | v4 status |
|---|---|---|---|
| C1 | **The catalogue was templated and degenerate.** | Only 122 distinct (fmin,fmax,fdom) triples for 219 species; 18 shared 1500/7000/3500. That caps any frequency-only classifier at **55.7 %** top-1. Under the lint's tolerance-aware rule, perfect-measurement ceilings are 44.3 % globally (v3.2 catalogue) and 54.8–83.9 % per realm. | Two descriptors were added, `t` (vocal type) and `nr` (note rate), each with a confidence code: **77.3 % global, 85.7–94.4 % per realm.** |
| C2 | **Gross errors.** | Ruby-throated and Rufous Hummingbird at 1.0–1.2 kHz (really chips at 2–10 kHz). Barn Owl modelled as an 800 Hz hoot (really a 1–10 kHz screech). Blackbird fdom 3500 → 2300. Chickadee 4500 → 3700. About 100 further refinements. | Fixed. Rationale per entry in `docs/bird-db-provenance.json`. |
| C3 | **Identity and taxonomy.** | The duplicate "Cedar Waxwing" was a Bohemian Waxwing. *Astur cooperii*, *Curruca communis*, *Crinifer concolor*. The American Moorhen split had left no Common Gallinule. | Fixed. Synonyms (`sy`) are used for occurrence matching. |
| C4 | **About 85 region lists were incomplete** (wintering ranges, the Maghreb, introductions). | Barn Swallow was missing from South America; Starling and Pheasant were missing from Asia and North America. | Fixed. |
| C5 | **Four false fun facts.** | The pigeon beak-magnetite compass (disproved in 2012), "kunang-kunang", peafowl infrasound, junglefowl crow length. | Fixed, along with about 20 smaller text corrections. |

### D. Benchmark methodology (v3.2 `tests/accuracy-benchmark.mjs`)

| # | Finding | Evidence | v4 status |
|---|---|---|---|
| D1 | **Features were synthesised directly**, bypassing the front end entirely. | A1–A7 were invisible to it. | Replaced by waveforms through each version's real front end. v3.2 is replayed verbatim through a real AnalyserNode in an OfflineAudioContext. |
| D2 | **Accuracy rose with noise** (global top-1: 17.5 % clean → 27.1 % noisy). | This is a tie-breaking artefact of degenerate entries. | Now a failing check (±2 SE). |
| D3 | **Statistical gaps:** unseeded, no CIs, best-of-N headline, no train/test split. | — | Fixed: seeded, species-bootstrap CIs, McNemar, held-out seed. |

## 2. Before / after

### Known-truth precision (`tests/dsp-precision.mjs`)

Conditions: real app code in Chromium; in-band SNR over 150 Hz–12 kHz with white noise.

| Measurement | v3.2 | v4 | Target |
|---|---|---|---|
| Tone peak frequency, RMS error (150 Hz–11 kHz, ≥10 dB SNR) | 36–46 Hz | **0.36–0.44 Hz** | ≤ 2 Hz |
| Tone detection at 0 dB SNR | 56.7 % | **100 %** | — |
| Tone detection at ≥ 6 dB SNR | 80–100 % | **100 %** | ≥ 99 % |
| F5 / F95 on band-limited noise | — | **≤ 0.5 %** | ± 3 % |
| Note rate, 2–40 notes/s | not measured | **≤ 1 %** | ± 5 % |
| SNR estimate (bias) | not measured | **< 0.1 dB** | ± 1 dB |
| False activity on white noise | — | **0.0–0.1 %** | ≤ 1 % |
| Wind gusts rejected / low tones kept (160–450 Hz) | — | **5/5 and 4/4** | — |
| CPU while recording | — | **≈ 7 ms per second of audio** | real time |

### Identification on identical synthetic clips (`tests/accuracy-benchmark.mjs`)

**Setup.**
- 220 species × 2 clips × 4 conditions, seed 5000 (held out; hyper-parameters were fitted on seed 1000).
- Single attempt per clip; 95 % CIs by bootstrap over species.
- Both versions score against the same v4 catalogue the generator uses. The differences below therefore come only from the front end and the scoring.
- "Region" means v4's soft region prior and v3.2's hard region filter.

| Condition (in-band SNR) | Metric | v3.2 | **v4** | McNemar (region top-1) | v4 ECE |
|---|---|---|---|---|---|
| clean (25 dB) | region top-1 / top-3 | 10.2 % / 25.9 % | **41.8 % [36.4–47.5] / 71.8 %** | 152 vs 13 clips, p = 6e-27 | 0.052 |
| | global top-1 / top-3 | 2.3 % / 10.7 % | **23.4 % / 45.7 %** | | |
| moderate (12 dB, traffic) | region top-1 / top-3 | 11.1 % / 23.9 % | **39.8 % [34.3–45.5] / 70.0 %** | 138 vs 12, p = 2e-24 | **0.031** |
| | global top-1 / top-3 | 2.5 % / 11.1 % | **23.4 % / 46.6 %** | | |
| noisy (3 dB, traffic, wind) | region top-1 / top-3 | 8.4 % / 21.8 % | **39.8 % [34.8–45.5] / 69.5 %** | 148 vs 10, p = 1e-27 | 0.067 |
| | global top-1 / top-3 | 2.5 % / 8.6 % | **20.5 % / 44.1 %** | | |
| extreme (−3 dB, traffic, wind) | region top-1 / top-3 | 7.7 % / 18.4 % | **32.7 % [28.0–37.7] / 56.1 %** | 122 vs 12, p = 5e-21 | 0.058 |
| | global top-1 / top-3 | 2.5 % / 8.2 % | **15.9 % / 38.9 %** | | |

**How to read this.**
- **Size of the gain.** On identical waveforms, v4 is right 3.6–4.7× as often as v3.2 within a region and 6–10× as often globally. The gain is significant at p < 10⁻²⁰ in every condition.
- **Calibration.** v4's probabilities are close to correct, with ECE 0.031–0.067; the benchmark prints a full reliability table for each condition. The design target of 0.05 is met under moderate noise and missed by up to 0.017 in the clean and noisy conditions.
- **Noise.** Accuracy now falls with noise, as it must; in v3.2's own benchmark it rose.
- **v3.2's own numbers.** Its benchmark reported 44.6 % region top-1 because it fed features straight into the scorer. Through its real front end, on real waveforms, v3.2 reaches about 10 %.
- **Data still limits v4.** Its 40 % sits below the catalogue's perfect-measurement ceiling of about 86–94 % per realm. The generator's intra-species pitch spread (8 % per individual plus catalogue error) overlaps neighbouring species. Most remaining confusions are between species that share a texture and pitch band, for example House Wren → Common Chaffinch, Northern Cardinal → White-throated Sparrow and Eurasian Collared Dove → Common Cuckoo.

**End-to-end** (`tests/e2e-capture.mjs`).
- A synthesised American Robin was fed to Chromium as the microphone and driven through the real UI.
- With mocked iNat and GBIF, it was ranked first at 96 % using the seasonal occurrence prior.
- Offline, it was ranked first at 64 % using the region prior.
- The AudioWorklet tap is bit-exact.

## 3. Limits — what this audit does not establish

- **No real recordings were available.** xeno-canto, Macaulay and Wikimedia are blocked by this environment's network policy.
  - The benchmark is a *self-consistency* test. The generator renders each species from its own catalogue entry, deliberately mismatched to the model in pitch spread, note-rate jitter, texture realisations, noise and level.
  - It therefore shows that the measurement chain is sound and the probabilities calibrated for sounds that obey the catalogue. It cannot show how well the catalogue matches real birds.
  - Real-world accuracy remains **unmeasured**.
- **Catalogue values come from expert knowledge, not new measurements.**
  - 87 of 220 entries carry `cf:"l"` and 34 carry `c:"l"`.
  - 212 `fdom` values still sit on a 100 Hz grid.
  - The next step with the largest payoff is measuring `fdom`, F5/F95, vocal type and note rate from about 10 quality-A recordings per species with `analyzePCM` itself. That makes catalogue and measurement the same operator.
- **Open-set detection is weak.** With 20 % of species hidden, AUROC is ≈ 0.58: summary acoustic features cannot reliably flag an unseen species when the catalogue is dense. The app therefore reports low-probability results as "Uncertain" rather than claiming an unknown-species detector.
- **Single dominant voice.** Overlapping singers, strong reverberation and distant birds (where high frequencies are attenuated) are outside the generator. The peak mixture and background terms give some robustness, but it is untested.
- **The occurrence-prior code paths are tested against mocked iNaturalist/GBIF responses.** Their documented request shapes are used, but the live APIs could not be reached from this environment.
