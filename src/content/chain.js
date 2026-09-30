/* =========================================================
   Audio Extender — processing chain (shared)

   One Chain per AudioContext:
     input → AutoEq → EQ → bass → dialogue → night → stereo matrix
           → normalization → boost → limiter → clipper → out → destination

   Loaded right before content/page.js in the page's MAIN world, and by the
   Chrome offscreen document (tab capture). Exposes one factory on
   window.__audioExtenderChain; page.js takes it and deletes it before any
   page script runs. Settings are read through `env` getters (S, active, duck).
   ========================================================= */
(() => {
  'use strict';

  if (window.__audioExtenderEngine || window.__audioExtenderChain) return; // already running (re-injection)

  // captured before page.js patches AudioNode.prototype / HTMLMediaElement.prototype
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const origPlay = HTMLMediaElement.prototype.play;

  const dbToLin = (db) => Math.pow(10, db / 20);
  const linToDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

  /** env: { S, active, duck } — live getters into the engine's state */
  function createChainKit(env) {
    /* ---------------------------------------------------------
       Processing chain for one AudioContext
       --------------------------------------------------------- */
    class Chain {
      constructor(ctx) {
        this.ctx = ctx;
        const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
        const biquad = (type, f, q = 1) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };

        this.input = gain();
        this.out = gain();

        this.aePre = gain();
        this.aeFilters = [];
        this.eqPre = gain();
        this.eqFilters = [];

        this.bass = biquad('lowshelf', 100);
        this.dlgLow = biquad('peaking', 250, 0.7);
        this.dlgHigh = biquad('peaking', 2800, 0.9);

        this.night = ctx.createDynamicsCompressor();
        this.night.knee.value = 12;
        this.night.attack.value = 0.003;
        this.night.release.value = 0.25;
        this.nightMakeup = gain();

        // Stereo matrix: L' = ll·L + rl·R, R' = rr·R + lr·L  (width, mono, balance)
        this.mxIn = gain();
        this.mxIn.channelCount = 2;
        this.mxIn.channelCountMode = 'explicit';
        this.mxIn.channelInterpretation = 'speakers'; // mono sources are up-mixed to both sides
        this.mxSplit = ctx.createChannelSplitter(2);
        this.mxMerge = ctx.createChannelMerger(2);
        this.ll = gain(); this.rl = gain(0); this.rr = gain(); this.lr = gain(0);
        origConnect.call(this.mxIn, this.mxSplit);
        origConnect.call(this.mxSplit, this.ll, 0); origConnect.call(this.ll, this.mxMerge, 0, 0);
        origConnect.call(this.mxSplit, this.lr, 0); origConnect.call(this.lr, this.mxMerge, 0, 1);
        origConnect.call(this.mxSplit, this.rl, 1); origConnect.call(this.rl, this.mxMerge, 0, 0);
        origConnect.call(this.mxSplit, this.rr, 1); origConnect.call(this.rr, this.mxMerge, 0, 1);

        this.agc = gain();
        this.agcTap = ctx.createAnalyser();
        this.agcTap.fftSize = 2048;
        this.agcDb = null;
        this.agcTimer = 0;

        this.boost = gain();

        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.002;
        this.limiter.release.value = 0.12;
        this.limiterTrim = gain(); // cancels the compressor's automatic makeup gain
        this.clipper = ctx.createWaveShaper();
        this.clipper.curve = softClipCurve();
        this.clipper.oversample = '2x';

        // Metering (after processing)
        this.meterIn = gain();
        this.meterIn.channelCount = 2;
        this.meterIn.channelCountMode = 'explicit';
        this.meterIn.channelInterpretation = 'speakers';
        this.meterSplit = ctx.createChannelSplitter(2);
        this.anL = ctx.createAnalyser(); this.anL.fftSize = 2048;
        this.anR = ctx.createAnalyser(); this.anR.fftSize = 2048;
        this.spec = ctx.createAnalyser(); this.spec.fftSize = 4096; this.spec.smoothingTimeConstant = 0.7;
        this.toDest = gain();   // the default device; muted while another device plays (see setSink)
        origConnect.call(this.out, this.toDest);
        origConnect.call(this.toDest, ctx.destination);
        this.sinkId = '';
        this.sinkEl = null;
        this.msd = null;
        this.onSinkLost = null;
        origConnect.call(this.out, this.meterIn);
        origConnect.call(this.meterIn, this.meterSplit);
        origConnect.call(this.meterSplit, this.anL, 0);
        origConnect.call(this.meterSplit, this.anR, 1);
        origConnect.call(this.out, this.spec);
        this.tBuf = new Float32Array(2048);
        this.fBuf = new Float32Array(2048);

        this.key = null;
        this.apply();
      }

      /** Rewire when the structure changes, otherwise just update parameters. */
      apply() {
        const key = structureKey();
        if (key !== this.key) { this.rebuild(); this.key = key; }
        this.updateParams();
      }

      rebuild() {
        const ctx = this.ctx;
        const stageNodes = [this.input, this.aePre, ...this.aeFilters, this.eqPre, ...this.eqFilters, this.bass, this.dlgLow, this.dlgHigh,
          this.night, this.nightMakeup, this.mxMerge, this.agc, this.boost, this.limiter, this.limiterTrim, this.clipper];
        for (const n of stageNodes) { try { origDisconnect.call(n); } catch { /* not connected */ } }

        // filters are recreated because their count/types may change
        this.aeFilters = env.active && env.S.autoeq.id ? env.S.autoeq.filters.map(() => ctx.createBiquadFilter()) : [];
        this.eqFilters = env.active && env.S.eq.on ? eqFilterSpecs().map(() => ctx.createBiquadFilter()) : [];

        let cur = this.input;
        const link = (n) => { origConnect.call(cur, n); cur = n; };
        if (env.active) {
          if (this.aeFilters.length) { link(this.aePre); this.aeFilters.forEach(link); }
          if (this.eqFilters.length) { link(this.eqPre); this.eqFilters.forEach(link); }
          if (env.S.fx.bass.on) link(this.bass);
          if (env.S.fx.dialog.on) { link(this.dlgLow); link(this.dlgHigh); }
          if (env.S.fx.night.on) { link(this.night); link(this.nightMakeup); }
          if (matrixOn()) { origConnect.call(cur, this.mxIn); cur = this.mxMerge; }
          if (env.S.fx.norm.on) { origConnect.call(cur, this.agcTap); link(this.agc); }
          link(this.boost);
          if (env.S.limiter.on) { link(this.limiter); link(this.limiterTrim); link(this.clipper); }
        }
        origConnect.call(cur, this.out);

        clearInterval(this.agcTimer);
        this.agcDb = null;
        this.agc.gain.value = 1;
        if (env.active && env.S.fx.norm.on) this.agcTimer = setInterval(() => this.agcStep(), 200);
      }

      updateParams() {
        const t = this.ctx.currentTime, T = 0.015;
        const set = (param, v) => param.setTargetAtTime(v, t, T);
        set(this.out.gain, env.duck);
        if (!env.active) return;

        if (this.aeFilters.length) {
          set(this.aePre.gain, dbToLin(env.S.autoeq.preamp));
          env.S.autoeq.filters.forEach((spec, i) => setFilter(this.aeFilters[i], spec, set));
        }
        if (this.eqFilters.length) {
          set(this.eqPre.gain, dbToLin(env.S.eq.preamp));
          eqFilterSpecs().forEach((spec, i) => setFilter(this.eqFilters[i], spec, set));
        }

        set(this.bass.gain, env.S.fx.bass.gain);

        const d = env.S.fx.dialog.amount / 100;
        set(this.dlgLow.gain, -4 * d);
        set(this.dlgHigh.gain, 7 * d);

        // DynamicsCompressorNode adds automatic makeup gain of 0.6 × |level at 0 dBFS| (Web Audio spec).
        const n = env.S.fx.night.amount / 100;
        const nT = -20 - 30 * n, nR = 2 + 10 * n;
        set(this.night.threshold, nT);
        set(this.night.ratio, nR);
        set(this.nightMakeup.gain, dbToLin(0.3 * nT * (1 - 1 / nR))); // keep half of the automatic makeup

        // stereo matrix: width w (0 = mono … 2 = extra wide), balance b (-1 … 1)
        const w = env.S.fx.mono.on ? 0 : (env.S.fx.width.on ? env.S.fx.width.value / 100 : 1);
        const a = (1 + w) / 2, c = (1 - w) / 2;
        const b = env.S.fx.balance.value / 100;
        const gl = Math.min(1, 1 - b), gr = Math.min(1, 1 + b);
        set(this.ll.gain, gl * a); set(this.rl.gain, gl * c);
        set(this.rr.gain, gr * a); set(this.lr.gain, gr * c);

        set(this.boost.gain, env.S.gain / 100);
        set(this.limiter.threshold, env.S.limiter.threshold);
        set(this.limiterTrim.gain, dbToLin(0.6 * env.S.limiter.threshold * (1 - 1 / 20))); // remove makeup entirely
      }

      /** Slow automatic gain towards the loudness target. */
      agcStep() {
        if (this.ctx.state !== 'running') return;
        this.agcTap.getFloatTimeDomainData(this.tBuf);
        let sum = 0;
        for (let i = 0; i < this.tBuf.length; i++) sum += this.tBuf[i] * this.tBuf[i];
        const db = linToDb(Math.sqrt(sum / this.tBuf.length));
        if (db < -60) return; // silence: keep current gain
        this.agcDb = this.agcDb === null ? db : this.agcDb * 0.93 + db * 0.07;
        const want = Math.max(-12, Math.min(12, env.S.fx.norm.target - this.agcDb));
        this.agc.gain.setTargetAtTime(dbToLin(want), this.ctx.currentTime, 1);
      }

      levels() {
        const read = (an) => {
          an.getFloatTimeDomainData(this.tBuf);
          let peak = 0, sum = 0;
          for (let i = 0; i < this.tBuf.length; i++) {
            const v = Math.abs(this.tBuf[i]);
            if (v > peak) peak = v;
            sum += v * v;
          }
          return { peak, rms: Math.sqrt(sum / this.tBuf.length) };
        };
        return {
          l: read(this.anL),
          r: read(this.anR),
          gr: env.active && env.S.limiter.on ? this.limiter.reduction : 0,
        };
      }

      /** 72 log-spaced bars in 0…1, 20 Hz – 20 kHz. */
      spectrum(bars = 72) {
        this.spec.getFloatFrequencyData(this.fBuf);
        const binHz = this.ctx.sampleRate / this.spec.fftSize;
        const out = new Array(bars).fill(0);
        for (let i = 0; i < bars; i++) {
          const f0 = 20 * Math.pow(1000, i / bars), f1 = 20 * Math.pow(1000, (i + 1) / bars);
          let b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
          let m = -Infinity;
          for (let b = b0; b < b1 && b < this.fBuf.length; b++) if (this.fBuf[b] > m) m = this.fBuf[b];
          out[i] = Math.max(0, Math.min(1, (m + 95) / 75));
        }
        return out;
      }

      /**
       * Output device of this chain ('' = the default device). Rejects if the device can't be used;
       * the chain then plays on the default device — never silent.
       *   AudioContext.setSinkId (Chrome / Edge) — directly.
       *   Otherwise (Firefox): out → MediaStreamDestination → hidden <audio> → setSinkId.
       */
      async setSink(id) {
        id = id || '';
        if (id === this.sinkId) return;
        const ctx = this.ctx;
        if (typeof ctx.setSinkId === 'function') {
          try { await ctx.setSinkId(id); this.sinkId = id; }
          catch (e) { await ctx.setSinkId('').catch(() => {}); this.sinkId = ''; throw e; }
          return;
        }
        if (!id) { this.sinkToDestination(); return; }
        if (!this.sinkEl) {
          this.msd = ctx.createMediaStreamDestination();
          origConnect.call(this.out, this.msd);
          this.sinkEl = new Audio();
          this.sinkEl.srcObject = this.msd.stream;
          // the device went away / playback broke: back to the default device
          this.sinkEl.addEventListener('error', () => { this.sinkToDestination(); if (this.onSinkLost) this.onSinkLost(); });
        }
        try {
          await this.sinkEl.setSinkId(id);
          await origPlay.call(this.sinkEl);
        } catch (e) {
          this.sinkToDestination();
          throw e;
        }
        // only now silence the default output, so there is never a gap
        this.toDest.gain.value = 0;
        this.sinkId = id;
      }

      sinkToDestination() {
        this.toDest.gain.value = 1;
        if (this.sinkEl) {
          this.sinkEl.pause();
          this.sinkEl.srcObject = null;
          this.sinkEl = null;
          try { origDisconnect.call(this.out, this.msd); } catch { /* ignore */ }
          this.msd = null;
        }
        this.sinkId = '';
      }

      close() { clearInterval(this.agcTimer); if (this.sinkEl) this.sinkToDestination(); }
    }

    function setFilter(node, spec, set) {
      if (node.type !== spec.type) node.type = spec.type;
      set(node.frequency, Math.max(10, Math.min(22000, spec.f)));
      set(node.gain, spec.g || 0);
      // Web Audio interprets Q of lowpass/highpass in dB
      const q = spec.type === 'lowpass' || spec.type === 'highpass' ? 20 * Math.log10(Math.max(0.1, spec.q)) : spec.q;
      set(node.Q, q);
    }

    function softClipCurve() {
      // linear up to 0.8, smooth knee to a hard ceiling of 1.0
      const n = 4096, curve = new Float32Array(n), knee = 0.8;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
        const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
        curve[i] = Math.sign(x) * y;
      }
      return curve;
    }

    function eqFilterSpecs() {
      if (env.S.eq.mode === 'param') return env.S.eq.bands;
      const freqs = env.S.eq.mode === 'g10' ? G10 : G31;
      const q = env.S.eq.mode === 'g10' ? 1.41 : 4.32;
      return freqs.map((f, i) => ({ type: 'peaking', f, g: env.S.eq[env.S.eq.mode][i] || 0, q }));
    }
    const G10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const G31 = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

    function matrixOn() {
      return env.S.fx.mono.on || (env.S.fx.width.on && env.S.fx.width.value !== 100) || env.S.fx.balance.value !== 0;
    }

    function structureKey() {
      if (!env.active) return 'bypass';
      return JSON.stringify([
        env.S.autoeq.id ? env.S.autoeq.filters.map((f) => f.type) : 0,
        env.S.eq.on ? eqFilterSpecs().map((f) => f.type) : 0,
        env.S.fx.bass.on, env.S.fx.dialog.on, env.S.fx.night.on, matrixOn(), env.S.fx.norm.on, env.S.limiter.on,
      ]);
    }

    return { Chain };
  }

  Object.defineProperty(window, '__audioExtenderChain', { value: createChainKit, configurable: true });
})();
