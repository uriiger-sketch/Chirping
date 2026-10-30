---
name: bioacoustic-dsp
description: Signal-chain physics for Chirping's measurement front-end (index.html: captureTap, createAnalyzer/analyzePCM, DSP constants). Use before touching audio capture, the STFT, noise estimation, activity detection, peak/band/tonality/note-rate measurements, or anything that reads an AnalyserNode — and whenever a change could alter a measured frequency, level or time. Gives the rules, the numbers they rest on, and the known-truth tests (tests/dsp-precision.mjs) a change must keep passing.
---

# Bioacoustic DSP — rules for Chirping's measurement chain

You are acting as the panel's signal-processing physicist. Your job is that every number the app
measures is a physical quantity with a known error bar. Nothing in this file is a style preference:
each rule exists because breaking it produced a measured failure in v3.2 (see docs/physics-audit.md).

## Ground rules (non-negotiable)

1. **Measure linear quantities.** Analysis runs on linear PCM and linear power `P_k = 2|X_k|²/(N·Σw²)`,
   normalised so `Σ_k P_k` equals the mean signal power (Parseval, one-sided). dB appears only for
   display and for log-parabolic interpolation. Never sum, average, subtract, or take centroids of dB
   values — `getByteFrequencyData` bytes are `floor(255·(dB+100)/70)`, clipped at −30 dB; averaging them
   is a geometric mean of power with a hard ceiling.
2. **Never sample-pick spectral bins.** If you must reduce resolution, pool (power sum for energy, max
   for display). Keeping every 10th bin of a Blackman spectrum lost >20 dB for 61 % and >50 dB for 45 %
   of steady-tone frequencies — v3.2's main defect.
3. **No nonlinear or adaptive processing before measurement.** The DynamicsCompressor, AGC, noise
   suppression, echo cancellation and lossy codecs (Opus/AAC via MediaRecorder) all change relative
   levels over time and frequency. The classifier reads the raw tap from `srcNode`; the HP/LP/compressor
   chain feeds only the analyser used for the picture. Keep `getUserMedia` constraints
   `{echoCancellation:false, noiseSuppression:false, autoGainControl:false}`.
4. **Clock by samples, never by frames of the display.** Time = sample index / `ctx.sampleRate`.
   `requestAnimationFrame` runs at 60/120 Hz and stops when the screen locks.
5. **Use the real sample rate.** Read `ctx.sampleRate` after creating the context; never pass
   `sampleRate` to `AudioContext` (Firefox rejects a MediaStreamSource at a different rate; iOS changes
   the hardware rate when the mic opens, so create the context *after* getUserMedia). Cap the band at
   0.45 × the track's rate for Bluetooth headsets (8–16 kHz inside a 48 kHz context).

## Time–frequency design (Gabor limit Δt·Δf ≥ 1/4π)

| Choice | Value | Why |
|---|---|---|
| Window | Hann, N = 2^round(log2(0.0213·fs)) → 1024 at 44.1/48 kHz (21 ms) | Bird notes are 10–200 ms and sweep up to ~100 kHz/s; 43 ms windows smeared 60 kHz/s sweeps across 2.6 kHz |
| Hop | N/4 (5.3 ms, 187 frames/s) | Envelope Nyquist 94 Hz ≫ 40 notes/s |
| Band | 150 Hz – 12 kHz (+1 guard bin each side) | Covers every catalogue species (lowest fdom 300 Hz); guard bins let an edge peak be interpolated |
| Pre-filter | 2nd-order Butterworth HP at 100 Hz, linear | Hann sidelobes (−31 dB, −18 dB/oct) would leak wind/handling rumble into 150–300 Hz |
| Trim | 0.2 s at both ends | Button-press transients |

Frequency precision comes from **interpolation, not bin width**. Log-parabolic (Gaussian) interpolation
on three bins: `p = ½(α−γ)/(α−2β+γ)` with α,β,γ = ln P at k−1,k,k+1; `f = (k+p)·fs/N`. Measured maximum
bias for a pure tone: Hann 0.344 Hz at N=2048 (0.016 bin), so ≈0.7 Hz at N=1024; Blackman 0.143 Hz.
Interpolate on the mean active power (not the noise-subtracted one) so all three bins are positive.

## Noise floor and activity

- **Pass 1:** per-bin 20th percentile of 3-frame-smoothed power over non-silent frames, divided by
  `qBias = 0.417` (the quantile/mean ratio of that statistic on white noise; 0.411–0.420 measured at
  16–48 kHz). Cap each bin at 4× (6 dB) its ±½-octave running median so a continuous singer is not
  subtracted as noise.
- **Pass 2:** the quantile is biased high when calls fill most frames (a 72 %-occupied band read
  −2.6 dB SNR low). Re-estimate as the plain mean over frames ≥4 hops from any activity or wind,
  rejecting frames whose total exceeds 1.5× the median (a stationary 250-bin total varies ~6 %).
- **Digital silence** (exact zeros from a muted/padded device) is excluded; `deadPow = 1e-14` per bin
  is both the silence threshold and an absolute floor. Without it a 25 % zero-padded clip read 152 dB SNR.
- **Activity:** 3×3 (time × frequency) smoothed per-cell SNR; hysteresis on its frame maximum, on at
  9 dB, off below 5 dB; bridge gaps ≤20 ms; drop notes <15 ms. The thresholds are set by extreme-value
  statistics of ~250 correlated cells: on/off 6/3 dB gave 99 % false activity on white noise, 8/5 gave
  0.2 %, 9/5 gives 0.0–0.1 %. Re-measure if you change N, smoothing or band.
- **Wind:** a frame is wind if energy below 400 Hz is >15 dB over its floor, exceeds the 400–1600 Hz
  energy by 1.5×, has its energy-weighted log-frequency centroid below 280 Hz, and is *not* tonal
  (≥90 % of the 150–1600 Hz excess within ±2 bins of its maximum means a tone — keep it). Dilate ±3 frames
  over shoulders with the same signature at >9 dB. Per-frame argmax tests are fragile on exponential
  per-bin statistics — use centroids.

## What is measured (signal cells only: active frame ∧ smoothed SNR ≥ 6 dB)

`peak`/`peaks` (aggregate-spectrum peaks, ≥−20 dB re strongest, ≥1/12 octave apart), `f5…f95`
(energy quantiles of noise-subtracted signal cells, bins uniform over ±df/2), `conc1`/`conc3` (share of
each frame's signal energy within ±3 bins of its strongest / three strongest peaks), `pitchIQR`
(energy-weighted IQR of per-frame dominant ln f), `noteRate` (autocorrelation of the dB-re-noise band
envelope over the active span; smallest-lag peak ≥85 % of the best, ≥0.25, ≥3 periods; else null),
`snrDb` (mean active power above floor / integrated floor, 150 Hz–12 kHz), `windFrac`, `clipFrac`
(|x| ≥ 0.99). Prototype values: pure tone conc ≈1.00/1.00; 5-harmonic stack 0.68/0.93; 2–6 kHz noise
0.15/0.38; repeated notes pitchIQR ≲0.08; varied warble ≳0.25.

## Web Audio pitfalls seen in this codebase

- `BiquadFilterNode.Q` for lowpass/highpass is in **dB** (resonance), not a dimensionless Q.
- `node.disconnect()` with no argument drops **every** outgoing connection — it would silently cut a tap
  branch. Rewire only the display branch below `displayIn`.
- An AudioWorklet or ScriptProcessor with no path to `destination` may never be pulled; route through a
  zero-gain GainNode. `addModule` is per context. Engines reuse input buffers — copy before posting.
- iOS reports `state === "interrupted"`; stop and analyse what was captured. Close the context on stop.

## Verification (run after any change here)

`node tests/dsp-precision.mjs` must report, on the real app code in Chromium:
tone RMS ≤ 2 Hz at ≥10 dB in-band SNR (currently 0.33–0.44 Hz, v3.2 36–46 Hz); detection ≥ 99 % at
≥6 dB (currently 100 % from 0 dB; v3.2 57 % at 0 dB); F5/F95 within ±3 % (currently ≤0.5 %); note rate
within ±5 % over 2–40 /s (≤1 %); SNR bias within ±1 dB (<0.1 dB); false activity ≤1 % on white noise;
wind gusts rejected and 160–450 Hz tones kept; streaming cost ≪ real time (≈7 ms CPU per audio second).
`node tests/e2e-capture.mjs` must show the AudioWorklet tap bit-exact. SNR in every test is in-band
(150 Hz–12 kHz), signal power while on, white Gaussian noise — state it if you change it.
