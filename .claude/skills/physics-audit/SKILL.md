---
name: physics-audit
description: Run Chirping's three-expert audit panel (signal-processing physicist, ornithologist-bioacoustician, statistician) over the app or a change to it, with fixed checklists and a measured-not-asserted evidence rule. Use when asked to audit accuracy, review a change to capture/DSP/scoring/catalogue, or before publishing any accuracy claim. Produces or updates docs/physics-audit.md.
---

# Physics audit — the Chirping expert panel

An audit here is a set of **measurements**, not opinions. Every finding must carry a number produced
in the session (a script you ran, a test output, a computed statistic) or be marked "unverified".

## Panel and scope (run the three in parallel; each reads the code itself)

1. **Signal-processing physicist** — load `.claude/skills/bioacoustic-dsp`. Checklist: linear vs dB
   arithmetic; spectral pooling vs sample-picking; nonlinear/adaptive stages before measurement; clock
   source; sample-rate handling; window, hop and band vs bird time–frequency structure; noise-floor
   estimator bias; activity false-alarm rate; edge cases (digital silence, clipping, wind, Bluetooth
   bandwidth, iOS interruption). Evidence: known-truth signals through the real code.
2. **Ornithologist-bioacoustician** — load `.claude/skills/bird-acoustic-data`. Split BIRD_DB into
   chunks of ~70 species, one agent per chunk, each reading its lines in full. Checklist per entry:
   reference vocalization, fdom/fmin/fmax vs known measurements, vocal type and note rate, realms
   (wintering, Maghreb, introductions), taxonomy and synonyms, false facts. Report only material
   problems with confidence, as JSON when edits are wanted.
3. **Statistician** — load `.claude/skills/classifier-statistics`. Checklist: are scores probabilities;
   priors (soft vs hard, normalisation, partial data); calibration; open set; benchmark validity
   (does it run the real front-end, seeds, CIs, paired tests, monotonicity, train/test separation,
   degeneracy ceiling).

## Evidence rules

- Reproduce before you fix: e.g. v3.2's decimation loss was computed from the Blackman window response
  (82 % / 61 % / 45 % of tone frequencies below −3 / −20 / −50 dB) before any code changed.
- Compare old and new **on identical inputs** (tests/lib/legacy.js preserves v3.2 verbatim, replayed
  through a real AnalyserNode in an OfflineAudioContext).
- Quote held-out numbers, with CIs, and state the conditions (in-band SNR definition, noise types,
  sample rates, seed).
- Separate what the audit can and cannot establish. Without labelled field recordings, no claim about
  real-world identification accuracy is supportable; say so explicitly.

## Commands

```
node tests/db-lint.mjs          # catalogue invariants + perfect-measurement ceilings
node tests/dsp-precision.mjs    # known-truth precision targets, v3.2 alongside
node tests/e2e-capture.mjs      # fake microphone → real UI; tap exactness; offline path
node tests/accuracy-benchmark.mjs   # v4 vs v3.2 on identical clips, held-out seed, CIs, ECE
```
(All Playwright tests start their own server; Playwright resolves from node_modules, PLAYWRIGHT_PATH,
or /opt/node-tools.)

## Report format (docs/physics-audit.md)

1. Scope and evidence rule. 2. Findings table: id, area, finding, measured evidence, severity, status.
3. Before/after numbers from the four commands, with conditions. 4. Limits and open problems — what
was not measured and what data would settle it. Keep per-entry catalogue rationale in
docs/bird-db-provenance.json, not in the report.
