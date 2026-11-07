// Pulse chord tracker
// Listens on a high-resolution AnalyserNode, builds a 12-note chroma vector from spectral peaks,
// matches it against the 24 major/minor triads and steers the visualizer palette toward the
// colour of the chord's root.
//
// Pitch → colour follows Scriabin's "clavier à lumières": notes go round the colour wheel in
// circle-of-fifths order, so harmonically close chords get neighbouring colours:
//   C red · G orange · D yellow · A green · E cyan · B sky blue · F# blue · C# violet
//   G# purple · D# magenta · A# rose · F crimson
// Minor chords keep their root's hue but are drawn less saturated (cooler, moodier).

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const pitchHue = pc => ((pc * 7) % 12) / 12;          // 0..1, circle of fifths, C = red

const LO = 55, HI = 2100, BASS_HI = 260;   // Hz: chroma range and the bass range used to pick the root
const EVAL_MS = 50;                        // analysis rate (20 Hz)
const MIN_SCORE = 0.62;                    // cosine match needed to call a chord
const SWITCH_EVALS = 3;                    // a new chord must win this many evaluations in a row (~150 ms)
const HOLD_MS = 1600;                      // keep the last chord this long through unclear passages
const wrap = x => x - Math.round(x);       // -0.5..0.5

export class ChordTracker {
  constructor(analyser) {
    this.an = analyser;
    this.buf = new Float32Array(analyser.frequencyBinCount);
    this.binHz = analyser.context.sampleRate / analyser.fftSize;
    this.kLo = Math.max(2, Math.floor(LO / this.binHz));
    this.kHi = Math.min(this.buf.length - 2, Math.ceil(HI / this.binHz));
    this.chroma = new Float32Array(12);     // smoothed, normalised
    this.bass = new Float32Array(12);
    this.tuning = 0;                         // cents/100 offset from A440, learned slowly
    this.enabled = true;
    this.chord = null;                       // { root, minor, name, score }
    this.cand = null; this.candN = 0; this.lastSeen = 0; this.tEval = 0;
    // palette state read by the visualizers
    this.hue = Math.random(); this.spread = 1; this.sat = 1;
    this.onChange = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on && this.chord) { this.chord = null; this.onChange?.(null); }
  }

  /** Call once per frame. `beat` = a beat was detected this frame. */
  update(now, dt, live, beat) {
    if (this.enabled && live && now - this.tEval >= EVAL_MS) { this.tEval = now; this.analyze(now); }
    const c = this.chord, k = 1 - Math.exp(-dt * 3.2);
    if (c) {
      this.hue += wrap(pitchHue(c.root) - this.hue) * k;      // glide the shortest way round the wheel
      this.spread += (0.3 - this.spread) * k;                  // keep the palette close to the chord colour
      this.sat += ((c.minor ? 0.68 : 1) - this.sat) * k;
    } else {
      this.hue += dt * 0.012 + (beat ? 0.05 : 0);              // original free-running colour cycle
      this.spread += (1 - this.spread) * k * 0.4;
      this.sat += (1 - this.sat) * k * 0.4;
    }
    this.hue -= Math.floor(this.hue);
  }

  analyze(now) {
    const b = this.buf; this.an.getFloatFrequencyData(b);
    let top = -Infinity;
    for (let k = this.kLo; k <= this.kHi; k++) if (b[k] > top) top = b[k];
    const raw = new Float32Array(12), bass = new Float32Array(12);
    if (top < -80) return this.decide(now, null);              // effectively silent
    const floor = Math.max(top - 48, -95);
    let ts = 0, tc = 0;
    for (let k = this.kLo; k <= this.kHi; k++) {
      const y0 = b[k - 1], y1 = b[k], y2 = b[k + 1];
      if (!(y1 > y0 && y1 >= y2 && y1 > floor)) continue;      // spectral peaks only
      const den = y0 - 2 * y1 + y2;
      const p = den < 0 ? 0.5 * (y0 - y2) / den : 0;           // parabolic interpolation → sub-bin frequency
      const f = (k + p) * this.binHz;
      const m = 69 + 12 * Math.log2(f / 440);
      const amp = Math.pow(10, (y1 - top) / 20);
      const dRaw = m - Math.round(m);
      ts += Math.sin(dRaw * 2 * Math.PI) * amp; tc += Math.cos(dRaw * 2 * Math.PI) * amp;
      const mt = m - this.tuning, n = Math.round(mt), dev = mt - n;
      const w = amp * Math.cos(Math.PI * dev) ** 2 * (f > 1000 ? 0.6 : 1);
      const pc = ((n % 12) + 12) % 12;
      raw[pc] += w;
      if (f < BASS_HI) bass[pc] += w;
    }
    if (tc > 0 || ts !== 0) this.tuning += (Math.atan2(ts, tc) / (2 * Math.PI) - this.tuning) * 0.01;
    let sum = 0; for (let i = 0; i < 12; i++) sum += raw[i];
    if (sum <= 0) return this.decide(now, null);
    let bsum = 0; for (let i = 0; i < 12; i++) bsum += bass[i];
    const ch = this.chroma, bs = this.bass;
    for (let i = 0; i < 12; i++) {
      ch[i] += (raw[i] / sum - ch[i]) * 0.35;
      bs[i] += ((bsum > 0 ? bass[i] / bsum : 0) - bs[i]) * 0.35;
    }
    // template match: cosine similarity with a weighted triad, plus a bonus when the bass agrees with the root
    let norm = 0; for (let i = 0; i < 12; i++) norm += ch[i] * ch[i];
    norm = Math.sqrt(norm) || 1;
    const tn = Math.sqrt(1 + 0.8 * 0.8 + 0.8 * 0.8);
    let best = null, bestS = -1;
    for (let r = 0; r < 12; r++) for (const minor of [false, true]) {
      const t = (r + (minor ? 3 : 4)) % 12, f5 = (r + 7) % 12;
      const s = (ch[r] + 0.8 * ch[t] + 0.8 * ch[f5]) / (norm * tn) + 0.12 * bs[r] - (minor ? 0.01 : 0);
      if (s > bestS) { bestS = s; best = { root: r, minor }; }
    }
    this.decide(now, bestS >= MIN_SCORE ? { ...best, score: bestS } : null);
  }

  decide(now, c) {
    const cur = this.chord;
    if (!c) {
      if (cur && now - this.lastSeen > HOLD_MS) { this.chord = null; this.onChange?.(null); }
      this.cand = null; this.candN = 0;
      return;
    }
    const same = (a, b) => a && b && a.root === b.root && a.minor === b.minor;
    if (same(c, cur)) { cur.score = c.score; this.lastSeen = now; this.cand = null; this.candN = 0; return; }
    if (same(c, this.cand)) this.candN++; else { this.cand = c; this.candN = 1; }
    if (this.candN >= SWITCH_EVALS && (!cur || c.score > cur.score * 0.97 || now - this.lastSeen > 400)) {
      this.chord = { ...c, name: NOTE_NAMES[c.root] + (c.minor ? 'm' : '') };
      this.lastSeen = now; this.cand = null; this.candN = 0;
      this.onChange?.(this.chord);
    }
  }
}
