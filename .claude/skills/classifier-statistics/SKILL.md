---
name: classifier-statistics
description: Statistical rules for Chirping's species posterior (MODEL, logLik, posterior, makePrior, regionPrior, gbifReweight in index.html) and for evaluating it (tests/accuracy-benchmark.mjs). Use before changing likelihood terms, priors, hyper-parameters or confidence display, before claiming any accuracy number, and when designing or reading a benchmark. Covers log-frequency likelihoods, occurrence priors, open-set handling, calibration, and a benchmark protocol with the red flags that invalidated v3.2's numbers.
---

# Classifier statistics — building and judging the posterior

You are acting as the panel's statistician. Two failures to never repeat: v3.2's "confidence" was a
softmax (T=4) of ad-hoc scores, boosted ×1.5/×1.35 and renormalised over the top 3 so it always summed
to 100 %; and its benchmark synthesised features directly, so it could not see the broken front-end
and reported accuracy that *rose* with noise.

## The model (index.html, `MODEL`)

- **Log-frequency everywhere.** Pitch variation between individuals is multiplicative: compare
  `ln f`, never Hz. A fixed 700 Hz σ meant ±117 % tolerance for a 600 Hz dove and ±8 % for an 8.5 kHz
  Goldcrest.
- **Every term is a normalised density**, so species with vague (wide) catalogue ranges are not
  favoured: peak — mixture over detected peaks of N(ln f_j; ln fdom, σ) with octave alternatives
  (weight `harm`); band — `logPlateau` (uniform on the interval + Gaussian tails, integrates to 1) for
  F5 ∈ [ln fmin−τ, ln fdom] and F95 ∈ [ln fdom, ln fmax+τ]; texture — Gaussian in (logit conc1,
  logit conc3, ln(pitchIQR+0.02)) around per-type prototypes; note rate — `logPlateau` on ln rate with
  octave alternatives and explicit P(rate detected).
- **Robustness by mixture, not by clipping:** each term is mixed with a broad background (`outlier`);
  descriptors are trusted with probability `cTrust[c]`, otherwise the background density is used; low
  `cf` widens σ. A single wrong catalogue value degrades a species instead of vetoing it.
- **Priors:** soft region prior — `regionIn` (0.9) of the *mass* on species listed for the user's
  realm(s), the rest on all others (catalogue range lists are incomplete; a hard filter vetoes
  visitors). With local occurrence data: p ∝ (1−ε)·share^γ/Z + ε/K, γ = 0.5 (photo counts over-represent
  conspicuous birds), ε = 0.1 (unrecorded ≠ absent); if iNat returns its 500-species cap, absent species
  get half the smallest listed count, not zero. GBIF counts are known only for the top 5, so they may
  only redistribute mass **within** that block (partial normalisation, γ = 0.3) — never renormalise
  the whole posterior on a subset.
- **Open set:** an explicit "not in catalogue" class (prior `pOther`) whose likelihood is the mean of
  all species' likelihoods with widths ×1.75 plus 10 % log-uniform. Measured honestly, summary features
  separate unseen species poorly (AUROC 0.58 with 20 % of species hidden): the catalogue is dense in
  feature space. Communicate uncertainty through calibrated probabilities and the remaining-mass note,
  not through a claimed "unknown species" detector.
- **Display:** show posterior probabilities as they are; state where the rest of the mass is (other
  catalogue species, not in catalogue). Label the result "Uncertain" when the top probability < 0.25.

## Fitting and calibration

- Fit hyper-parameters on **training seeds only** (seed 1000) by coordinate search on region
  top-1 + ½·top-3; report on **held-out seeds** (5000). Prefer the conservative side of a flat optimum
  (the generator is cleaner than nature): v4 widened `sigRate` 0.12→0.15 and `sigIQR` 0.40→0.45 from
  the training optimum at a cost of ~1 point.
- Calibrate with one temperature on the log-likelihood, chosen to minimise NLL on training seeds
  (v4: T = 0.7; the mixture model was *under*-confident at T = 1, ECE 0.13 → 0.05).
- Report ECE (10 equal-width bins of top-1 probability), Brier score and the reliability table.

## Benchmark protocol (tests/accuracy-benchmark.mjs)

1. Render **waveforms** and run each version's real front-end. Never synthesise features.
2. The generator must not be the model: wider/other pitch spread, note-rate jitter beyond the
   catalogue range, several realisations per texture, noise the model never sees (pink, traffic,
   wind), random level (−30…−10 dBFS peak), both 44.1 and 48 kHz. Even so it is a self-consistency
   test — say so in every report.
3. Single-attempt accuracy only (best-of-N is optimistic and was v3.2's headline number).
4. CIs by **bootstrap over species** (trials of one species are correlated); paired comparisons on the
   same clips with **McNemar**; a monotonicity check — accuracy must not rise with noise beyond ±2 SE.
5. Report the catalogue's own perfect-measurement ceiling (`node tests/db-lint.mjs`) next to accuracy,
   so model error and data degeneracy are not confused.

## Red flags — stop and investigate

Accuracy rising with noise (tie-breaking among degenerate entries); confidences that always sum to 100 %;
a sweep that improves training seeds but not held-out seeds; any number produced without the real
front-end; a benchmark whose generator reads the same σ the model assumes; calibration claimed without
a reliability table.
