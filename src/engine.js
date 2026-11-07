// Pulse audio engine
// - Gapless: tracks are fully decoded to AudioBuffers and the next track is scheduled
//   sample-accurately to start the instant the current one ends.
// - Very long tracks (where a decoded buffer would be huge) fall back to a streaming
//   <audio> element; transitions around those are near-gapless rather than exact.
// - Signal chain: voice (ReplayGain) -> EQ preamp -> 10 bands -> analyser -> volume -> output

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const MAX_DECODED_BYTES = 700 * 1024 * 1024;

export const mediaUrl = t => `pulse://app/media?id=${t.id}`;

export class Engine extends EventTarget {
  constructor() {
    super();
    const ctx = this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.input = ctx.createGain();
    this.preamp = ctx.createGain();
    this.filters = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0;
      return b;
    });
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    // High-resolution tap for chord detection (~2.7 Hz per bin), parallel to the visual analyser.
    this.chordAnalyser = ctx.createAnalyser();
    this.chordAnalyser.fftSize = 16384;
    this.chordAnalyser.smoothingTimeConstant = 0.5;
    this.master = ctx.createGain();
    let node = this.input;
    for (const n of [this.preamp, ...this.filters, this.analyser, this.master]) { node.connect(n); node = n; }
    this.master.connect(ctx.destination);
    this.analyser.connect(this.chordAnalyser);

    this.cur = null;          // current voice
    this.nxt = null;          // pre-scheduled next voice (gapless)
    this.cache = new Map();   // track id -> Promise<AudioBuffer>
    this.token = 0;
    this.playing = false;
    this.getNext = () => null;               // set by the app: peek at the next track for auto-advance
    this.rg = { mode: 'album', preamp: 0, noTagDb: 0, preventClip: true };
    this.eq = { enabled: false, preamp: 0, gains: EQ_FREQS.map(() => 0) };
    this.volume = 1;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /* ---------------- settings ---------------- */
  setVolume(v) { this.volume = v; this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.015); }
  setEq(eq) {
    this.eq = eq;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(eq.enabled ? eq.gains[i] : 0, t, 0.02));
    this.preamp.gain.setTargetAtTime(eq.enabled ? Math.pow(10, eq.preamp / 20) : 1, t, 0.02);
  }
  setReplayGain(rg) {
    this.rg = rg;
    for (const v of [this.cur, this.nxt]) if (v) v.gain.gain.setTargetAtTime(this.rgGain(v.track), this.ctx.currentTime, 0.05);
    this.emit('rg');
  }
  rgInfo(track) {
    if (!track || this.rg.mode === 'off') return null;
    const album = this.rg.mode === 'album';
    let db = album ? (track.rgAlbum ?? track.rgTrack) : (track.rgTrack ?? track.rgAlbum);
    const peak = album ? (track.rgAlbumPeak ?? track.rgTrackPeak) : (track.rgTrackPeak ?? track.rgAlbumPeak);
    const tagged = db != null;
    if (!tagged) db = this.rg.noTagDb;
    db += this.rg.preamp;
    let g = Math.pow(10, db / 20);
    if (this.rg.preventClip && peak > 0 && g * peak > 1) g = 1 / peak;
    return { db: 20 * Math.log10(g), gain: g, tagged };
  }
  rgGain(track) { const i = this.rgInfo(track); return i ? i.gain : 1; }

  /* ---------------- loading ---------------- */
  streamOnly(t) {
    if (!t.duration) return false;
    return t.duration * this.ctx.sampleRate * Math.max(1, t.channels || 2) * 4 > MAX_DECODED_BYTES;
  }
  load(t) {
    if (this.cache.has(t.id)) return this.cache.get(t.id);
    const p = fetch(mediaUrl(t))
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(ab => this.ctx.decodeAudioData(ab));
    this.cache.set(t.id, p);
    p.catch(() => this.cache.delete(t.id));
    return p;
  }
  prune(keep) { for (const id of [...this.cache.keys()]) if (!keep.includes(id)) this.cache.delete(id); }

  /* ---------------- voices ---------------- */
  makeGain(track) {
    const g = this.ctx.createGain();
    g.gain.value = this.rgGain(track);
    g.connect(this.input);
    return g;
  }
  bufferVoice(track, buf, when, offset) {
    const gain = this.makeGain(track);
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(gain);
    src.start(when, Math.min(offset, Math.max(0, buf.duration - 0.01)));
    const v = { kind: 'buffer', track, buf, src, gain, t0: when - offset, duration: buf.duration, stopped: false };
    src.onended = () => { if (!v.stopped) this.voiceEnded(v); };
    return v;
  }
  streamVoice(track, offset) {
    const gain = this.makeGain(track);
    const el = new Audio();
    el.crossOrigin = 'anonymous'; el.preload = 'auto'; el.src = mediaUrl(track);
    const node = this.ctx.createMediaElementSource(el);
    node.connect(gain);
    const v = { kind: 'stream', track, el, node, gain, duration: track.duration, stopped: false };
    el.addEventListener('loadedmetadata', () => { if (isFinite(el.duration)) v.duration = el.duration; if (offset) el.currentTime = offset; }, { once: true });
    el.addEventListener('ended', () => { if (!v.stopped) this.voiceEnded(v); });
    el.addEventListener('error', () => { if (!v.stopped) this.emit('error', { track, message: 'Could not play this file' }); });
    if (this.playing) el.play().catch(() => {});
    return v;
  }
  dispose(v) {
    if (!v) return;
    v.stopped = true;
    try { if (v.src) { v.src.onended = null; v.src.stop(); v.src.disconnect(); } } catch { /* already stopped */ }
    if (v.el) { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); try { v.node.disconnect(); } catch {} }
    try { v.gain.disconnect(); } catch {}
  }

  /* ---------------- transport ---------------- */
  get track() { return this.cur ? this.cur.track : null; }
  get position() {
    const v = this.cur; if (!v) return 0;
    if (v.kind === 'stream') return v.el.currentTime || 0;
    return Math.max(0, Math.min(v.duration, this.ctx.currentTime - v.t0));
  }
  get duration() { return this.cur ? this.cur.duration : 0; }

  async play(track, offset = 0, autoplay = true) {
    const token = ++this.token;
    this.dispose(this.cur); this.dispose(this.nxt);
    this.cur = this.nxt = null;
    this.playing = autoplay;
    this.emit('loading', track);
    try {
      let v;
      if (this.streamOnly(track)) {
        v = this.streamVoice(track, offset);
      } else {
        const buf = await this.load(track);
        if (token !== this.token) return;
        v = this.bufferVoice(track, buf, this.ctx.currentTime + 0.03, offset);
      }
      this.cur = v;
      if (autoplay) { await this.ctx.resume(); if (v.el) v.el.play().catch(() => {}); }
      else await this.ctx.suspend();
      this.emit('track', { track, auto: false });
      this.emit('state', this.playing);
      this.prepareNext();
    } catch (e) {
      if (token !== this.token) return;
      console.error(e);
      this.emit('error', { track, message: 'Could not decode this file' });
      this.playing = false; this.emit('state', false);
    }
  }

  async pause() {
    if (!this.cur) return;
    this.playing = false;
    if (this.cur.el) this.cur.el.pause();
    await this.ctx.suspend();
    this.emit('state', false);
  }
  async resume() {
    if (!this.cur) return;
    this.playing = true;
    await this.ctx.resume();
    if (this.cur.el) this.cur.el.play().catch(() => {});
    this.emit('state', true);
  }
  toggle() { return this.playing ? this.pause() : this.resume(); }

  seek(t) {
    const v = this.cur; if (!v) return;
    t = Math.max(0, Math.min(t, v.duration - 0.05));
    if (v.kind === 'stream') { v.el.currentTime = t; }
    else {
      this.dispose(v);
      this.cur = this.bufferVoice(v.track, v.buf, this.ctx.currentTime + 0.02, t);
    }
    this.invalidateNext();
  }

  stop() {
    this.token++;
    this.dispose(this.cur); this.dispose(this.nxt);
    this.cur = this.nxt = null; this.playing = false;
    this.emit('state', false);
  }

  // Call when the queue, shuffle or repeat changes so the pre-scheduled track is re-picked.
  invalidateNext() {
    if (this.nxt) { this.dispose(this.nxt); this.nxt = null; }
    this.prepareNext();
  }

  async prepareNext() {
    const cur = this.cur; if (!cur) return;
    const token = this.token;
    const nt = this.getNext(cur.track);
    if (!nt) return;
    if (cur.kind !== 'buffer' || this.streamOnly(nt)) return;   // handled when the current voice ends
    let buf;
    try { buf = await this.load(nt); } catch { return; }
    if (token !== this.token || this.cur !== cur || this.nxt) return;
    const when = cur.t0 + cur.duration;
    if (when < this.ctx.currentTime + 0.02) return;              // too late to schedule exactly
    this.nxt = this.bufferVoice(nt, buf, when, 0);
    this.prune([cur.track.id, nt.id]);
  }

  voiceEnded(v) {
    if (v !== this.cur) return;
    if (this.nxt) {                         // gapless hand-off — already playing
      const n = this.nxt; this.nxt = null;
      this.dispose(v);
      this.cur = n; this.token++;
      this.emit('track', { track: n.track, auto: true });
      this.prepareNext();
      return;
    }
    const nt = this.getNext(v.track);
    this.dispose(v); this.cur = null;
    if (nt) this.emit('advance', nt);       // app moves the queue and calls play()
    else { this.playing = false; this.emit('state', false); this.emit('ended'); }
  }
}
