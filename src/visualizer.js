// Milkdrop-style visualizer: WebGL fragment shaders with frame feedback, driven by an AnalyserNode.
export const PRESETS = ['Nebula', 'Spectrum Ring', 'Tunnel', 'Classic Bars'];

const VS = `attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*.5+.5;gl_Position=vec4(aPos,0.,1.);}`;
const SCENE_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPrev, uAudio;
uniform vec2 uRes;
uniform float uTime, uPhase, uBass, uMid, uTreb, uBeat, uHue, uPreset;

vec3 hsv(float h,float s,float v){vec3 k=clamp(abs(mod(h*6.+vec3(0.,4.,2.),6.)-3.)-1.,0.,1.);return v*mix(vec3(1.),k,s);}
float spec(float x){return texture2D(uAudio,vec2(clamp(x,0.,1.),.25)).r;}
float wave(float x){return texture2D(uAudio,vec2(clamp(x,0.,1.),.75)).r*2.-1.;}
vec2 rot(vec2 p,float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c)*p;}

void main(){
  float asp=uRes.x/uRes.y;
  vec2 p=(vUv-.5)*vec2(asp,1.);
  float r=length(p), a=atan(p.y,p.x);
  float ang=a/6.28318+.5;
  vec3 col=vec3(0.);
  vec2 fp=p; float decay=.9;

  if(uPreset<.5){
    /* NEBULA: warped zoom feedback + circular oscilloscope */
    fp=rot(p,.004+uMid*.025)*(.982-uBass*.04);
    fp+=.004*vec2(sin(p.y*7.+uPhase*1.7),cos(p.x*7.+uPhase*1.3))*(1.+uTreb*2.);
    decay=.93;
    float w=wave(abs(ang*2.-1.));
    float rr=.2+uBass*.14+w*(.08+uMid*.12);
    float d=abs(r-rr);
    col+=hsv(uHue+abs(ang*2.-1.)*.5,.75,1.)*(.0025/(d+.0025))*(.18+uTreb*.6);
    col+=hsv(uHue+.5,.6,1.)*uBeat*.0015/(r+.03);
  } else if(uPreset<1.5){
    /* SPECTRUM RING: radial bars bursting outward */
    fp=rot(p,-.004-uBass*.012)*(.99-uBass*.02);
    decay=.8;
    float x=abs(ang*2.-1.);
    float s=spec(x*.92+.02);
    float inner=.16+uBass*.06;
    float gap=step(.18,fract(ang*96.));
    float bar=gap*smoothstep(inner-.004,inner,r)*(1.-smoothstep(inner+s*.38-.004,inner+s*.38,r));
    col+=hsv(uHue+x*.55+r*.6,.85,1.)*bar*(.3+s*.5);
    col+=hsv(uHue+.15,.6,1.)*(.004/(abs(r-inner+.01)+.004))*.25;
    col+=hsv(uHue,.6,1.)*.004*uBass/(r+.04);
  } else if(uPreset<2.5){
    /* TUNNEL: rings ride the spectrum, speed follows bass */
    fp=p*.97; decay=.55;
    float z=.22/max(r,.002)+uPhase;
    float s=spec(abs(fract(z*.07)*2.-1.)*.8);
    float ring=pow(.5+.5*sin(z*7.),5.);
    float spoke=pow(.5+.5*sin(ang*6.28318*10.+z*1.5),8.);
    float fade=smoothstep(.0,.35,r);
    col+=hsv(uHue+z*.025+abs(ang*2.-1.)*.3,.75,1.)*(ring*(.15+s*1.6)+spoke*(.05+uTreb*1.4))*fade;
    col+=hsv(uHue+.5,.5,1.)*uBeat*.3*ring*fade;
  } else {
    /* CLASSIC BARS: mirrored spectrum with rising smoke */
    fp=p+vec2(sin(p.y*10.+uPhase)*.002,-.0045); decay=.82;
    float n=56.;
    float fx=vUv.x*n; float id=floor(fx);
    float s=spec((id+.5)/n*.96+.02);
    float inb=step(.16,fract(fx))*step(fract(fx),.84);
    float base=.28, h=s*.62, y=vUv.y;
    if(y>base){
      float on=step(y-base,h);
      float seg=step(.25,fract((y-base)*90.));
      col+=hsv(uHue+(y-base)*.9+id/n*.25,.8,1.)*inb*on*mix(.55,1.,seg);
    } else {
      float dy=base-y;
      col+=hsv(uHue+dy*.9+id/n*.25,.8,1.)*inb*step(dy,h*.45)*(1.-dy/(h*.45+.001))*.28;
    }
  }

  vec2 fuv=fp/vec2(asp,1.)+.5;
  vec3 prev=texture2D(uPrev,fuv).rgb;
  float inside=step(0.,fuv.x)*step(fuv.x,1.)*step(0.,fuv.y)*step(fuv.y,1.);
  col+=max(prev*decay-.004,0.)*inside;
  gl_FragColor=vec4(min(col,1.2),1.);
}`;
const BLIT_FS = `
precision highp float;varying vec2 vUv;uniform sampler2D uTex;uniform float uBeat;
void main(){vec3 c=texture2D(uTex,vUv).rgb;
  vec2 q=vUv-.5;c*=1.-dot(q,q)*.9;c+=uBeat*.025;
  gl_FragColor=vec4(c,1.);}`;

export class Visualizer {
  constructor(canvas, analyser) {
    this.canvas = canvas; this.analyser = analyser;
    const gl = this.gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.scene = this.program(SCENE_FS); this.blit = this.program(BLIT_FS);
    const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.AW = 256; this.pix = new Uint8Array(this.AW * 2);
    this.audioTex = this.tex(this.AW, 2, gl.LUMINANCE, this.pix);
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    const ny = analyser.context.sampleRate / 2, n = analyser.frequencyBinCount;
    this.bins = []; for (let i = 0; i <= this.AW; i++) this.bins.push(Math.min(n - 1, Math.round(30 * Math.pow(16000 / 30, i / this.AW) / ny * n)));
    this.W = 0; this.H = 0; this.fbos = []; this.cur = 0;
    this.preset = 0; this.active = false; this.isPlaying = () => true;
    this.s = { bass: 0, mid: 0, treb: 0, beat: 0, avg: 0, lastBeat: 0, hue: Math.random(), phase: 0, t: performance.now() };
    this.frame = this.frame.bind(this);
  }
  compile(type, src) { const gl = this.gl, s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  program(fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, VS)); gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  tex(w, h, fmt, data) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  resize() {
    const gl = this.gl, dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h; this.canvas.width = w; this.canvas.height = h;
    this.fbos.forEach(f => { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); });
    this.fbos = [0, 1].map(() => {
      const tex = this.tex(w, h, gl.RGBA, null), fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return { tex, fb };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  start() { if (this.active) return; this.active = true; this.s.t = performance.now(); requestAnimationFrame(this.frame); }
  stop() { this.active = false; }
  next() { this.preset = (this.preset + 1) % PRESETS.length; return PRESETS[this.preset]; }
  band(f0, f1) {
    const ny = this.analyser.context.sampleRate / 2, n = this.freq.length;
    const a = Math.max(1, Math.floor(f0 / ny * n)), b = Math.max(a + 1, Math.floor(f1 / ny * n));
    let s = 0; for (let i = a; i < b; i++) s += this.freq[i]; return s / (b - a) / 255;
  }
  frame(now) {
    if (!this.active) return;
    requestAnimationFrame(this.frame);
    this.resize();
    const gl = this.gl, s = this.s, AW = this.AW, pix = this.pix;
    const dt = Math.min(0.05, (now - s.t) / 1000); s.t = now;
    let tb = 0, tm = 0, tt = 0;
    if (this.isPlaying()) {
      this.analyser.getByteFrequencyData(this.freq); this.analyser.getByteTimeDomainData(this.time);
      for (let i = 0; i < AW; i++) {
        let m = 0; for (let j = this.bins[i]; j <= Math.max(this.bins[i], this.bins[i + 1] - 1); j++) if (this.freq[j] > m) m = this.freq[j];
        pix[i] = Math.min(255, m * (0.85 + i / AW * 0.55));
        pix[AW + i] = this.time[Math.floor(i / AW * this.time.length)];
      }
      tb = this.band(25, 150); tm = this.band(150, 2000); tt = Math.min(1, this.band(2000, 9000) * 1.6);
    } else {
      for (let i = 0; i < AW; i++) { pix[i] = pix[i] * 0.92; pix[AW + i] = 128 + Math.sin(i * 0.05 + now * 0.002) * 6; }
    }
    const sm = (v, t, u, d) => v + (t - v) * (t > v ? u : d);
    s.bass = sm(s.bass, tb, .55, .09); s.mid = sm(s.mid, tm, .4, .07); s.treb = sm(s.treb, tt, .5, .1);
    s.avg += (s.bass - s.avg) * 0.02;
    if (s.bass > s.avg * 1.22 && s.bass > 0.32 && now - s.lastBeat > 260) { s.beat = 1; s.lastBeat = now; s.hue += 0.06; }
    s.beat *= 0.88; s.hue += dt * 0.015; s.phase += dt * (0.35 + s.bass * 2.2);

    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AW, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, pix);
    const src = this.fbos[this.cur], dst = this.fbos[1 - this.cur], u = this.scene.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.scene.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(u.uPrev, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.audioTex); gl.uniform1i(u.uAudio, 1);
    gl.uniform2f(u.uRes, this.W, this.H); gl.uniform1f(u.uTime, now / 1000); gl.uniform1f(u.uPhase, s.phase);
    gl.uniform1f(u.uBass, s.bass); gl.uniform1f(u.uMid, s.mid); gl.uniform1f(u.uTreb, s.treb);
    gl.uniform1f(u.uBeat, s.beat); gl.uniform1f(u.uHue, s.hue % 1); gl.uniform1f(u.uPreset, this.preset);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.blit.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex); gl.uniform1i(this.blit.u.uTex, 0);
    gl.uniform1f(this.blit.u.uBeat, s.beat);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }
}
