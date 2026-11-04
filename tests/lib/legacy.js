// Chirping v3.2 classifier, preserved VERBATIM (commit c5fd436, index.html:1149-1399) so the
// benchmark can measure the old pipeline and the new one on identical waveforms. Only the
// wrapper is new: it supplies the globals the old code read (FREQ_BINS, S.hzPerBin, S.recSec)
// and replays the old capture path — a real AnalyserNode (fftSize 4096, smoothing 0.2) behind
// HP 300 Hz → LP 12 kHz → DynamicsCompressor, sampled at 60 frames/s, every 10th bin kept.
// Plain script: defines window.LegacyChirping. Do not "fix" anything below the marker.
(function (root) {
  'use strict';
  const FREQ_BINS = 192;
  const S = { hzPerBin: 125, recSec: 0 };

  // Old front-end, replayed in an OfflineAudioContext (exact Chrome AnalyserNode behaviour).
  async function legacyFrames(pcm, fs) {
    const ctx = new OfflineAudioContext(1, pcm.length, fs);
    const buf = ctx.createBuffer(1, pcm.length, fs); buf.copyToChannel(Float32Array.from(pcm), 0);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = .7;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 12000; lp.Q.value = .7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 15; comp.ratio.value = 4; comp.release.value = .1;
    const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = .20;
    src.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(an); an.connect(ctx.destination);
    const step = Math.floor(an.frequencyBinCount / FREQ_BINS);
    S.hzPerBin = step * fs / an.fftSize;
    const frames = [], dur = pcm.length / fs, raw = new Uint8Array(an.frequencyBinCount);
    for (let k = 1; k / 60 < dur - 1e-3; k++) {
      ctx.suspend(k / 60).then(() => {
        an.getByteFrequencyData(raw);
        const sub = new Float32Array(FREQ_BINS); for (let i = 0; i < FREQ_BINS; i++) sub[i] = raw[i * step] / 255; // verbatim decimation
        frames.push(sub); ctx.resume();
      });
    }
    src.start(); await ctx.startRendering();
    S.recSec = Math.floor(dur); // old code: integer seconds from setInterval
    return frames;
  }

  // Old classifyBirds without the network step: hard region filter (≥5 species) + softmax top-3.
  function legacyRank(feats, DB, region) {
    let pool = DB; if (region) { const reg = DB.filter(b => b.r.includes(region)); if (reg.length >= 5) pool = reg; }
    return pool.map(b => ({ b, raw: scoreSpecies(feats, b) })).sort((a, c) => c.raw - a.raw);
  }

  // ───────────── verbatim v3.2 code below this line ─────────────
  // ── Spectral features ─────────────────────────────────────────────────────────
  function computeFeatures(frames){
    if(!frames.length)return{peak:0,centroid:0,signal:0,duration:0,peaks:[],activeRatio:0};

    // Raw signal computed BEFORE noise subtraction — used for the silence gate in onStop()
    const energies=frames.map(f=>f.reduce((s,v)=>s+v,0)/f.length);
    const rawSignal=energies.reduce((a,b)=>a+b,0)/energies.length;
    // Noise floor estimation
    const sortedE=[...energies].sort((a,b)=>a-b);
    const noiseFloor=sortedE[Math.floor(sortedE.length*0.10)];
    const threshold=noiseFloor+(sortedE[sortedE.length-1]-noiseFloor)*0.25;

    // Active frame selection
    const activeFrames=frames.filter((_,i)=>energies[i]>threshold);
    const useFrames=activeFrames.length>=5?activeFrames:frames;

    // Noise-spectrum estimation (quietest 10% of frames)
    const noiseCount=Math.max(1,Math.floor(frames.length*0.10));
    const noiseIdxs=energies.map((e,i)=>[e,i]).sort(([a],[b])=>a-b).slice(0,noiseCount).map(([,i])=>i);
    const noiseSpec=new Float32Array(FREQ_BINS);
    for(const idx of noiseIdxs)for(let b=0;b<FREQ_BINS;b++)noiseSpec[b]+=frames[idx][b]/noiseCount;

    // Noise-subtracted average spectrum (subtract only 85% of noise to preserve quiet harmonics)
    const avg=new Float32Array(FREQ_BINS);
    for(const f of useFrames)for(let b=0;b<FREQ_BINS;b++)avg[b]+=Math.max(0,f[b]-0.85*noiseSpec[b])/useFrames.length;

    // Smooth spectrum with weighted 3-point MA to suppress single-bin noise spikes
    const sm=new Float32Array(FREQ_BINS);
    for(let i=1;i<FREQ_BINS-1;i++)sm[i]=(avg[i-1]+2*avg[i]+avg[i+1])/4;
    sm[0]=avg[0];sm[FREQ_BINS-1]=avg[FREQ_BINS-1];

    // Actual Hz per downsampled sub-bin (uses real device sample rate, not hardcoded NYQUIST)
    const H=S.hzPerBin||125;

    // Multi-peak detection on smoothed spectrum: local maxima in the bird band (200 Hz–12 kHz)
    const peaks=[];
    for(let i=2;i<FREQ_BINS-2;i++){
      if(sm[i]>sm[i-1]&&sm[i]>sm[i-2]&&sm[i]>sm[i+1]&&sm[i]>sm[i+2]&&sm[i]>0.005){
        const hz=i*H;
        if(hz>200&&hz<12000)peaks.push({hz,amp:sm[i]});
      }
    }
    peaks.sort((a,b)=>b.amp-a.amp);
    // Drop weak noise blips: keep peaks with at least 15% of the strongest peak's amplitude
    const maxAmp=peaks.length?peaks[0].amp:0;
    const topPeaks=peaks.filter(p=>p.amp>=maxAmp*0.15).slice(0,5);

    // Traditional display features (use smoothed spectrum for consistency)
    let peakIdx=0;
    for(let i=1;i<FREQ_BINS;i++)if(sm[i]>sm[peakIdx])peakIdx=i;
    const peak=Math.round(peakIdx*H);
    let wS=0,wD=0;
    for(let i=0;i<FREQ_BINS;i++){wS+=i*sm[i];wD+=sm[i];}
    const centroidBin=wD>0?wS/wD:0;
    const centroid=Math.round(centroidBin*H);
    // Spectral bandwidth: energy-weighted spread around the centroid, in Hz.
    // This is the standard "spectral bandwidth" audio feature — it lets us match
    // a species' known vocal-range width (fmax-fmin), not just its peak frequency,
    // which is essential for telling apart species that happen to share a dominant
    // frequency but sing narrow whistles vs. wide, buzzy trills.
    let bwS=0;
    for(let i=0;i<FREQ_BINS;i++)bwS+=sm[i]*Math.pow(i-centroidBin,2);
    const bandwidth=Math.round((wD>0?Math.sqrt(bwS/wD):0)*H);
    const duration=S.recSec>0?S.recSec:frames.length/60;
    const activeRatio=activeFrames.length/(frames.length||1);

    // Precompute per-recording peak-amplitude aggregates ONCE here — scoreSpecies()
    // is called once per species (up to 219 times per classification) and previously
    // recomputed these identical, bird-independent sums on every single call.
    const peakMaxAmp=topPeaks.length?Math.max(...topPeaks.map(p=>p.amp)):0;
    const peakTotalAmp=topPeaks.reduce((s,p)=>s+p.amp,0);

    return{peak,centroid,bandwidth,signal:rawSignal,duration,peaks:topPeaks,activeRatio,peakMaxAmp,peakTotalAmp};
  }

  // ── Region + scoring ──────────────────────────────────────────────────────────
  function getRegion(lat,lon){
    if(lat>=15&&lat<=72&&lon>=-170&&lon<=-52)return"na";
    if(lat>=35&&lat<=72&&lon>=-10&&lon<=40)return"eu";
    if(lat>=-10&&lat<=37&&lon>=-18&&lon<=52)return"af";
    if(lat>=5&&lat<=72&&lon>=40&&lon<=145)return"as";
    if(lat>=-45&&lat<=-10&&lon>=113&&lon<=155)return"au";
    if(lat>=-55&&lat<=15&&lon>=-82&&lon<=-34)return"sa";
    return null;
  }
  // Shared Gaussian similarity, hoisted to module scope so scoreSpecies (called up
  // to ~220 times per classification, once per species) never reallocates a closure.
  function gauss(x,mu,sigma){return Math.exp(-0.5*Math.pow((x-mu)/sigma,2));}
  // Scoring weights — chosen by grid sweeps against a 219-species self-recognition
  // benchmark (tests/accuracy-benchmark.mjs), not hand-picked. First pass: 333 configs
  // against a single clean-noise condition. Second pass: 96 configs re-checked against
  // the realistic scenario (region-filtered + moderate noise, single-attempt accuracy,
  // not optimistic best-of-N) that matches the app's actual default usage. The second
  // sweep moved the needle by under 1.5 percentage points across every metric — evidence
  // this 3-feature model (peak match / range coverage / centroid) has hit its practical
  // ceiling; a bandwidth-matching term was also tried at multiple weights and never beat
  // zero, since a weighted-std estimate from a handful of scattered peaks is too noisy
  // to trust. Meaningfully surpassing this would need new, independently-verifiable
  // acoustic features (e.g. real recording data), not further weight tuning.
  const SCORE_W={sigmaPeak:700,wPeak:0.90,wRange:0.05,wCentroid:0.05,specBase:1200};
  function scoreSpecies(feats,bird){
    if(feats.peaks&&feats.peaks.length>0){
      // Best peak: frequency match weighted by relative amplitude, so a loud true
      // peak always outranks a quiet noise blip at a "better" frequency.
      // peakMaxAmp/peakTotalAmp are precomputed once per recording in computeFeatures
      // (they don't depend on `bird`) rather than recomputed on every species call.
      const maxAmp=feats.peakMaxAmp||1;
      const bestPeak=Math.max(...feats.peaks.map(p=>gauss(p.hz,bird.fdom,SCORE_W.sigmaPeak)*(0.5+0.5*p.amp/maxAmp)));
      // Centroid corroboration (half weight — it's a softer signal)
      const centroidScore=gauss(feats.centroid,bird.fdom,SCORE_W.sigmaPeak)*0.5;
      // Range coverage: what fraction of detected peak energy falls within [fmin,fmax],
      // weighted by specificity — matching a narrow, well-defined range is stronger
      // evidence than matching a broad range that most recordings would satisfy anyway.
      const totalAmp=feats.peakTotalAmp||0;
      const inRangeAmp=feats.peaks.filter(p=>p.hz>=bird.fmin&&p.hz<=bird.fmax).reduce((s,p)=>s+p.amp,0);
      const specificity=SCORE_W.specBase/(SCORE_W.specBase+(bird.fmax-bird.fmin));
      const rangeScore=(totalAmp>0?inRangeAmp/totalAmp:0)*(0.55+0.45*specificity);
      return bestPeak*SCORE_W.wPeak+rangeScore*SCORE_W.wRange+centroidScore*SCORE_W.wCentroid;
    }else{
      // Fallback: no peaks detected — use raw spectral peak and centroid
      return gauss(feats.peak,bird.fdom,1500)*.45+gauss(feats.centroid,bird.fdom,1500)*.35
            +(feats.peak>=bird.fmin&&feats.peak<=bird.fmax?.15:.05);
    }
  }
  function softmax(sc){const T=4,ex=sc.map(s=>Math.exp(s*T)),sum=ex.reduce((a,b)=>a+b,0);return ex.map(e=>e/sum);}

  root.LegacyChirping = { legacyFrames, legacyRank, computeFeatures, scoreSpecies, softmax, getRegion, S, FREQ_BINS };
})(typeof window !== 'undefined' ? window : globalThis);
