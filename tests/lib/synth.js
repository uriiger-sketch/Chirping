// Chirping test synthesiser — physically parameterised bird-like vocalisations and field noise,
// rendered as PCM so tests exercise the REAL measurement chain (STFT → features → posterior)
// instead of fabricating features. Shared by tests/accuracy-benchmark.mjs, tests/dsp-precision.mjs
// and tests/e2e-capture.mjs. Plain script: in a page it defines window.ChirpSynth; in Node it is
// loaded with vm and defines globalThis.ChirpSynth.
//
// The generator is DELIBERATELY not the classifier's model (see .claude/skills/classifier-statistics):
// pitch spread per individual is drawn wider than the model assumes, note rates jitter outside the
// catalogue range, each vocal type has several random realisations (FM shape, harmonic roll-off,
// noise colour), and the noise mix contains wind and traffic the model never sees explicitly.
// It is still a self-consistency test: it can only show the pipeline is sound and calibrated for
// sounds that obey the catalogue — not that the catalogue matches real birds.
(function (root) {
  'use strict';
  function rng(seed) { // mulberry32 — reproducible across Node and browsers
    let a = seed >>> 0;
    const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.normal = () => { let u = 0; while (!u) u = f(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * f()); };
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.logRange = (lo, hi) => lo * Math.exp(Math.log(hi / lo) * f());
    f.pick = arr => arr[Math.floor(f() * arr.length)];
    return f;
  }

  // RBJ biquads (direct form I), used for coloured / band-limited noise.
  function biquad(type, fs, f0, Q) {
    const w = 2 * Math.PI * Math.min(f0, 0.45 * fs) / fs, al = Math.sin(w) / (2 * Q), c = Math.cos(w), a0 = 1 + al;
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
    const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = -2 * c / a0, A2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return v => { const y = B0 * v + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; return y; };
  }
  const hann = (u) => u <= 0 || u >= 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
  const env = (u, a = 0.12) => u <= 0 || u >= 1 ? 0 : Math.min(1, u / a, (1 - u) / a) ** 1.5; // note envelope

  // Band-limited noise centred on fc spanning ≈[lo,hi] (4th-order edges + resonant emphasis at fc).
  function bandNoise(R, fs, n, lo, hi, fc) {
    const h1 = biquad('hp', fs, lo, 0.707), h2 = biquad('hp', fs, lo, 0.707), l1 = biquad('lp', fs, hi, 0.707), l2 = biquad('lp', fs, hi, 0.707);
    const bp = biquad('bp', fs, fc, 1.6), out = new Float64Array(n);
    for (let i = 0; i < n; i++) { const w = R.normal(), b = l2(l1(h2(h1(w)))); out[i] = 0.45 * b + 1.1 * bp(b); }
    return out;
  }

  // One note of a given texture, written into y starting at sample i0 (n samples).
  function note(R, y, fs, i0, n, kind, f, lo, hi) {
    if (n < 8) return;
    if (kind === 'w' || kind === 't') { // FM tone: flat, up-, down-slur or arch around f
      const shape = R.pick(['flat', 'up', 'down', 'arch', 'down']), span = kind === 't' ? R.range(0.08, 0.35) : R.range(0.03, 0.3);
      const vib = R.range(0, 0.015), vr = R.range(5, 30), h2 = R.range(0, 0.12); let ph = R() * 6.28, ph2 = R() * 6.28;
      for (let i = 0; i < n; i++) {
        const u = i / n; let g = 0;
        if (shape === 'up') g = span * (u - 0.5); else if (shape === 'down') g = span * (0.5 - u); else if (shape === 'arch') g = span * (0.25 - (u - 0.5) ** 2) * 2;
        const fi = Math.min(hi, Math.max(lo, f * Math.exp(g + vib * Math.sin(2 * Math.PI * vr * i / fs))));
        ph += 2 * Math.PI * fi / fs; ph2 += 4 * Math.PI * fi / fs;
        y[i0 + i] += env(u) * (Math.sin(ph) + (2 * fi < 0.45 * fs ? h2 * Math.sin(ph2) : 0));
      }
    } else if (kind === 'h') { // harmonic stack; the dominant partial (m-th) sits at f
      const m = R() < 0.75 ? 1 : 2, f0 = f / m, roll = R.range(0.35, 0.75), vib = R.range(0, 0.02), glide = R.range(-0.08, 0.08);
      const amps = []; for (let k = 1; k * f0 < Math.min(hi * 1.2, 0.45 * fs); k++) amps.push(k === m ? 1 : (k < m ? 0.5 : roll ** (k - m)));
      const ph = amps.map(() => R() * 6.28); let base = 0;
      for (let i = 0; i < n; i++) {
        const u = i / n; base += 2 * Math.PI * f0 * Math.exp(glide * (u - 0.5) + vib * Math.sin(2 * Math.PI * 6 * i / fs)) / fs;
        let s = 0; for (let k = 0; k < amps.length; k++) s += amps[k] * Math.sin((k + 1) * base + ph[k]);
        y[i0 + i] += env(u, 0.08) * s * 0.6;
      }
    } else if (kind === 'n' || kind === 'p') { // noisy screech / buzz, or a percussive click
      const nb = bandNoise(R, fs, n, Math.max(100, lo), Math.min(0.45 * fs, hi), f), am = kind === 'n' && R() < 0.5 ? R.range(40, 120) : 0;
      for (let i = 0; i < n; i++) { const u = i / n; y[i0 + i] += (kind === 'p' ? Math.exp(-6 * u) * hann(Math.min(1, u * 8)) : env(u, 0.1)) * nb[i] * (am ? 0.6 + 0.4 * Math.sin(2 * Math.PI * am * i / fs) : 1); }
    }
  }

  // A vocalisation bout for species b. Returns {pcm, truth}. opts: {fs, seconds, spreadScale}
  function vocalisation(b, seed, opts = {}) {
    const R = rng(seed), fs = opts.fs || 48000, total = opts.seconds || 4, n = Math.round(total * fs), y = new Float64Array(n);
    // Individual variation: peak pitch drawn log-normally around the catalogue value — ~8 % between
    // individuals, plus the catalogue's own likely error (wider for low-confidence entries); band
    // edges jitter ±10 %.
    const sp = Math.hypot(0.08, { h: 0.04, m: 0.08, l: 0.15 }[b.cf || 'm']) * (opts.spreadScale || 1);
    const lo = b.fmin * Math.exp(0.1 * R.normal()), hi = b.fmax * Math.exp(0.1 * R.normal());
    const f = Math.min(hi * 0.95, Math.max(lo * 1.05, b.fdom * Math.exp(sp * R.normal())));
    const t0 = R.range(0.6, 0.9), t1 = Math.min(total - 0.4, t0 + R.range(1.6, 2.8));
    const rate = b.nr ? R.logRange(b.nr[0], b.nr[1]) * Math.exp(0.08 * R.normal()) : 0;
    const notes = [];
    if (b.t === 'c') { // complex warble: varied syllables, mostly tonal, around the dominant pitch
      for (let t = t0; t < t1;) { const d = R.range(0.04, 0.18), fi = Math.min(hi, Math.max(lo, f * Math.exp(0.25 * R.normal())));
        notes.push([t, d, R() < 0.6 ? 'w' : R() < 0.6 ? 'n' : 'h', fi]); t += d + (rate ? Math.max(0.01, 1 / rate - d) : R.range(0.02, 0.1)); }
    } else if (rate) {
      const duty = b.t === 'p' ? 0.2 : R.range(0.35, 0.65), d = Math.min(0.6, duty / rate);
      for (let t = t0; t < t1; t += 1 / rate) notes.push([t, b.t === 'p' ? Math.min(d, 0.012) : d, b.t, f * Math.exp(0.03 * R.normal())]);
    } else { // sustained notes (nr = null)
      for (let t = t0; t < t1;) { const d = R.range(0.4, 1.1); notes.push([t, Math.min(d, t1 - t), b.t, f]); t += d + R.range(0.3, 0.6); }
    }
    for (const [t, d, kind, fi] of notes) note(R, y, fs, Math.round(t * fs), Math.min(Math.round(d * fs), n - Math.round(t * fs) - 1), kind, fi, lo, hi);
    return { pcm: y, fs, truth: { f, lo, hi, rate, kind: b.t, t0, t1 } };
  }

  // Field noise: pink background (Paul Kellet filter), optional traffic rumble and wind gusts.
  function fieldNoise(seed, fs, n, { traffic = 0, wind = 0 } = {}) {
    const R = rng(seed), y = new Float64Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = R.normal(); b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      y[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    if (traffic) { const l = biquad('lp', fs, 350, 0.9), l2 = biquad('lp', fs, 350, 0.9); for (let i = 0; i < n; i++) y[i] += traffic * 3 * l2(l(R.normal())); }
    if (wind) { // 1–3 gusts of brown-ish noise with slow envelopes
      const g = Math.floor(R.range(1, 4)); let br = 0;
      const gusts = Array.from({ length: g }, () => [R.range(0, n / fs), R.range(0.3, 1.0)]);
      for (let i = 0; i < n; i++) { br = 0.998 * br + R.normal() * 0.06; const t = i / fs; let e = 0; for (const [c, d] of gusts) e += Math.exp(-0.5 * ((t - c) / d) ** 2); y[i] += wind * e * br; }
    }
    return y;
  }

  // In-band (150 Hz–12 kHz) power of x over [i0,i1): Parseval on 2^k blocks with an ideal band mask.
  function inBandPower(x, fs, i0 = 0, i1 = x.length) {
    const N = 1024, re = new Float64Array(N), im = new Float64Array(N); let acc = 0, blocks = 0;
    for (let s = i0; s + N <= i1; s += N) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i]; im[i] = 0; }
      fft(re, im); let p = 0;
      for (let k = 1; k < N / 2; k++) { const f = k * fs / N; if (f >= 150 && f <= 12000) p += re[k] * re[k] + im[k] * im[k]; }
      acc += 2 * p / (N * N); blocks++;
    }
    return blocks ? acc / blocks : 0;
  }
  function fft(re, im) { // in-place radix-2 complex FFT (test utility)
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= N; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < N; i += len) { let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
          re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }

  // Mix a vocalisation with noise at an exact in-band SNR (signal power measured over its bout,
  // noise power over the whole clip), then apply a random overall gain. Returns Float32Array.
  function mix(voc, noise, snrDb, gain = 0.3) {
    const { pcm, fs, truth } = voc, i0 = Math.round(truth.t0 * fs), i1 = Math.round(truth.t1 * fs);
    const ps = inBandPower(pcm, fs, i0, i1), pn = inBandPower(noise, fs);
    const k = Math.sqrt(ps / (pn * 10 ** (snrDb / 10)));
    const out = new Float32Array(pcm.length); let pk = 0;
    for (let i = 0; i < pcm.length; i++) { out[i] = pcm[i] + k * noise[i]; pk = Math.max(pk, Math.abs(out[i])); }
    const g = gain / (pk || 1); for (let i = 0; i < out.length; i++) out[i] *= g;
    return out;
  }

  const api = { rng, vocalisation, fieldNoise, mix, inBandPower, bandNoise, biquad, fft };
  root.ChirpSynth = api;
})(typeof window !== 'undefined' ? window : globalThis);
