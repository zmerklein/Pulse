// Pulse 3D visualizer — WebGPU
// HDR (rgba16float) scene → bloom (two-level separable gaussian) → ACES tonemap.
// Presets:
//   Particle Galaxy     — up to 4M particles simulated in a compute shader (curl flow field + spectral shells)
//   Spectral Landscape  — 3D terrain built from a scrolling spectrogram, synthwave sky
//   Fractal Core        — ray-marched Mandelbulb whose power, rotation and glow follow the music
// Drag to orbit, scroll to zoom.

export const GPU_PRESETS = ['Particle Galaxy', 'Spectral Landscape', 'Fractal Core'];
export const QUALITY = {
  Low:   { particles: 262144,  scale: 0.5,  steps: 90,  label: 'Low' },
  High:  { particles: 1048576, scale: 0.75, steps: 150, label: 'High' },
  Ultra: { particles: 4194304, scale: 1.0,  steps: 230, label: 'Ultra' }
};
const HIST_ROWS = 128, BINS = 256;

/* ------------------------------ small math ------------------------------ */
const v3 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], norm: a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; } };
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0]);
}
function lookAt(eye, target, up) {
  const z = v3.norm(v3.sub(eye, target)), x = v3.norm(v3.cross(up, z)), y = v3.cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const d = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d]);
}

/* ------------------------------ WGSL ------------------------------ */
const COMMON = /* wgsl */`
struct U {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec4f,   // xyz, w = terrain scroll fraction
  res: vec4f,      // w, h, 1/w, 1/h  (scene target)
  audio: vec4f,    // bass, mid, treble, beat
  t: vec4f,        // time, dt, hue, phase
  params: vec4f,   // preset-specific
  chord: vec4f,    // x unused, y = palette spread, z unused, w = saturation scale
};
// Every palette colour is "base hue + offset". The chord tracker sets the base hue to the chord's
// colour and narrows the offsets (spread) so the whole scene reads as that chord.
fn hsv(h0: f32, s0: f32, v: f32) -> vec3f {
  let o = h0 - u.t.z;
  let h = u.t.z + (o - round(o)) * u.chord.y;
  let s = s0 * u.chord.w;
  let k = clamp(abs(fract(h + vec3f(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return v * mix(vec3f(1.0), k, s);
}
fn hash(n: u32) -> u32 { var x = n; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
fn rnd(n: u32) -> f32 { return f32(hash(n)) * (1.0 / 4294967295.0); }
struct FS { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FS {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: FS; o.pos = vec4f(p[i], 0.0, 1.0); o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5); return o;
}
fn rayDir(fc: vec2f, u: U) -> vec3f {
  let ndc = vec2f(fc.x * u.res.z * 2.0 - 1.0, 1.0 - fc.y * u.res.w * 2.0);
  let w = u.invViewProj * vec4f(ndc, 1.0, 1.0);
  return normalize(w.xyz / w.w - u.camPos.xyz);
}
`;

const PARTICLE_SIM = COMMON + /* wgsl */`
struct P { pos: vec4f, vel: vec4f };   // pos.w = life, vel.w = seed (spectral band 0..1)
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> spec: array<f32>;
@group(0) @binding(2) var<storage, read_write> ps: array<P>;

fn curl(p: vec3f, t: f32) -> vec3f {
  var v = -vec3f(1.3 * cos(1.3 * p.z + t * 0.7), 1.1 * cos(1.1 * p.x + t * 0.5), 1.7 * cos(1.7 * p.y + t * 0.6));
  let q = vec3f(p.y + p.z, p.z - p.x, p.x + p.y) * 0.7071;
  v -= 0.5 * vec3f(2.9 * cos(2.9 * q.z - t * 0.9), 3.1 * cos(3.1 * q.x + t * 0.8), 2.3 * cos(2.3 * q.y - t * 1.1));
  return v;
}
fn spawn(i: u32, k: u32, life: f32) -> P {
  let band = rnd(k);
  let s = spec[min(u32(band * 255.0), 255u)];
  let th = rnd(k + 1u) * 6.2831853;
  let ph = acos(2.0 * rnd(k + 2u) - 1.0);
  let dir = vec3f(sin(ph) * cos(th), cos(ph) * 0.65, sin(ph) * sin(th));
  let r = 0.35 + band * 1.25 + s * 0.5;
  var p: P;
  p.pos = vec4f(dir * r, life);
  p.vel = vec4f(dir * (0.05 + s * 1.4), band);
  return p;
}
@compute @workgroup_size(256)
fn init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= u32(u.params.x)) { return; }
  ps[i] = spawn(i, hash(i * 3u + 17u), rnd(i * 13u + 5u));
}
@compute @workgroup_size(256)
fn simulate(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; if (i >= u32(u.params.x)) { return; }
  var p = ps[i];
  let dt = min(u.t.y, 0.033);
  let bass = u.audio.x; let mid = u.audio.y; let treb = u.audio.z; let beat = u.audio.w;
  let seed = p.vel.w;
  p.pos.w -= dt * (0.12 + 0.18 * rnd(i * 7u + 1u));
  if (p.pos.w <= 0.0) {
    ps[i] = spawn(i, hash(i ^ (u32(u.t.x * 977.0) * 2654435761u)), 1.0);
    return;
  }
  let pos = p.pos.xyz;
  var v = p.vel.xyz;
  // turbulence (divergence-free flow field)
  v += curl(pos * (1.2 + mid * 0.8), u.t.x * 0.5 + u.t.w) * dt * (0.18 + mid * 0.9);
  let r = max(length(pos), 1e-4);
  let n = pos / r;
  let goal = 0.3 + seed * 0.95 + bass * 0.3;                    // each spectral band orbits at its own radius
  // drive toward a target orbital speed; inner bands spin faster → spiral shear
  var tng = cross(vec3f(0.0, 1.0, 0.0), pos);
  tng = tng / max(length(tng), 1e-4);
  let vt = (0.45 + treb * 0.9) * (1.5 - seed * 0.8) / sqrt(max(r, 0.25)) * 0.8;
  v += tng * (vt - dot(v, tng)) * dt * 2.5;
  let vr = dot(v, n);
  v -= n * ((r - goal) * 4.0 + vr * 1.2) * dt;                  // radial spring + damping
  v.y -= (pos.y * 3.0 + v.y * 0.8) * dt;                         // settle into a disc
  v += n * beat * dt * 6.0 * (0.25 + seed);                      // kick on beats
  v *= exp(-dt * 0.6);
  p.vel = vec4f(v, seed);
  p.pos = vec4f(pos + v * dt, p.pos.w);
  ps[i] = p;
}
`;

const PARTICLE_DRAW = COMMON + /* wgsl */`
struct P { pos: vec4f, vel: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> ps: array<P>;
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec3f, @location(1) q: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let p = ps[ii];
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var clip = u.viewProj * vec4f(p.pos.xyz, 1.0);
  let px = u.params.y * clamp(2.2 / max(clip.w, 0.05), 0.5, 2.5);
  clip = vec4f(clip.xy + c * px * u.res.zw * 2.0 * clip.w, clip.zw);
  let speed = length(p.vel.xyz);
  let life = p.pos.w;
  let fade = smoothstep(0.0, 0.25, life) * smoothstep(1.0, 0.85, life);
  let hue = u.t.z + p.vel.w * 0.28 - min(speed, 1.5) * 0.06;
  var o: VO;
  o.pos = clip;
  o.col = hsv(hue, 0.85 - min(speed, 1.0) * 0.3, 1.0) * (0.2 + speed * 1.1) * fade * u.params.z;
  o.q = c;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let f = exp(-dot(i.q, i.q) * 3.0);
  return vec4f(i.col * f, 1.0);
}
@fragment fn bg(i: FS) -> @location(0) vec4f {
  let d = rayDir(i.pos.xy, u);
  let g = pow(max(0.0, 1.0 - abs(d.y)), 6.0);
  let c = hsv(u.t.z + 0.55, 0.6, 1.0) * g * 0.025 + hsv(u.t.z, 0.5, 1.0) * u.audio.w * 0.01;
  return vec4f(c, 1.0);
}
`;

const TERRAIN = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> hist: array<f32>;
const NX: u32 = 192u; const NZ: u32 = ${HIST_ROWS}u;
const DZ: f32 = 0.16; const WIDTH: f32 = 9.0;
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) h: f32, @location(2) gx: vec2f };
fn heightAt(ix: u32, iz: u32) -> f32 {
  let f = abs(f32(ix) / f32(NX - 1u) * 2.0 - 1.0);
  let bin = min(u32(pow(f, 0.85) * 230.0) + 4u, 255u);
  let row = (u32(u.params.w) + NZ * 4u - iz) % NZ;
  let v = hist[row * 256u + bin];
  let edge = 0.4 + f * 0.85;                    // mountains rise toward the sides
  return v * v * 1.5 * edge + f * f * 0.35;
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let cell = vi / 6u; let k = vi % 6u;
  let cx = cell % (NX - 1u); let cz = cell / (NX - 1u);
  var ox = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  var oz = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let ix = cx + ox[k]; let iz = cz + oz[k];
  let h = heightAt(ix, iz);
  let x = (f32(ix) / f32(NX - 1u) - 0.5) * WIDTH;
  let z = -(f32(iz) - u.camPos.w) * DZ + 1.0;
  let wp = vec3f(x, h, z);
  var o: VO;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp; o.h = h;
  o.gx = vec2f(f32(ix), f32(iz) - u.camPos.w);
  return o;
}
fn skyColor(d: vec3f) -> vec3f {
  let y = d.y;
  var c = mix(hsv(u.t.z + 0.78, 0.7, 0.10), hsv(u.t.z + 0.62, 0.8, 0.02), clamp(y * 3.0, 0.0, 1.0));
  c += hsv(u.t.z + 0.95, 0.75, 1.0) * pow(max(0.0, 1.0 - abs(y) * 4.0), 3.0) * 0.07;
  return c;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let w = fwidth(i.gx);
  let g = abs(fract(i.gx * vec2f(1.0 / 6.0, 1.0 / 2.0) - 0.5) - 0.5) / max(w * vec2f(1.0 / 6.0, 1.0 / 2.0), vec2f(1e-4));
  let line = 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
  let hn = clamp(i.h / 1.6, 0.0, 1.0);
  let glow = hsv(u.t.z + 0.85 - hn * 0.35, 0.85, 1.0);
  var c = hsv(u.t.z + 0.75, 0.6, 0.025) + glow * hn * hn * 0.08;
  c += glow * line * (0.45 + hn * 2.2 + u.audio.x * 0.8);
  let dist = length(i.wp - u.camPos.xyz);
  let fog = 1.0 - exp(-max(dist - 3.0, 0.0) * 0.09);
  c = mix(c, skyColor(normalize(i.wp - u.camPos.xyz)), fog);
  return vec4f(c, 1.0);
}
@fragment fn sky(i: FS) -> @location(0) vec4f {
  let d = rayDir(i.pos.xy, u);
  var c = skyColor(d);
  // sun with retro stripes
  let sd = normalize(vec3f(0.0, 0.16, -1.0));
  let a = acos(clamp(dot(d, sd), -1.0, 1.0));
  let r = 0.2 + u.audio.x * 0.03;
  let rel = (d.y - sd.y) / r;
  let stripes = step(0.0, sin(rel * 38.0 + u.t.x * 2.0)) + step(0.25, rel);
  let disc = smoothstep(r, r - 0.004, a) * clamp(stripes, 0.0, 1.0);
  let sun = mix(hsv(u.t.z + 0.92, 0.8, 1.0), hsv(u.t.z + 0.12, 0.7, 1.0), clamp(rel * 0.5 + 0.5, 0.0, 1.0));
  c += sun * disc * (1.3 + u.audio.x * 1.2);
  c += sun * exp(-a * 9.0) * (0.25 + u.audio.x * 0.5);
  // stars
  let sp = floor(d * 420.0);
  let st = rnd(u32(sp.x * 73.0 + sp.y * 911.0 + sp.z * 4447.0 + 100000.0));
  c += vec3f(step(0.9975, st)) * 0.8 * smoothstep(0.05, 0.3, d.y) * (0.6 + u.audio.z);
  return vec4f(c, 1.0);
}
`;

const FRACTAL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> spec: array<f32>;
fn rotY(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
fn rotX(a: f32) -> mat3x3f { let c = cos(a); let s = sin(a); return mat3x3f(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
fn bulb(p0: vec3f, power: f32) -> vec2f {
  var z = p0; var dr = 1.0; var r = length(z); var trap = 1e9;
  for (var i = 0; i < 9; i++) {
    r = length(z);
    if (r > 2.0 || r < 1e-6) { break; }
    trap = min(trap, length(z - vec3f(0.0, 0.0, 0.6)));
    let th = acos(clamp(z.z / r, -1.0, 1.0)) * power;
    let ph = atan2(z.y, z.x) * power;
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    z = pow(r, power) * vec3f(sin(th) * cos(ph), sin(ph) * sin(th), cos(th)) + p0;
  }
  return vec2f(0.5 * log(max(r, 1e-6)) * r / dr, trap);
}
fn scene(p: vec3f) -> vec2f {
  let m = rotY(u.t.w * 0.35) * rotX(0.6 + sin(u.t.w * 0.2) * 0.3);
  let power = 7.0 + sin(u.t.w * 0.15) * 1.5 + u.audio.x * 2.2;
  return bulb(m * p, power);
}
fn normal(p: vec3f, e: f32) -> vec3f {
  let k = vec2f(1.0, -1.0);
  return normalize(k.xyy * scene(p + k.xyy * e).x + k.yyx * scene(p + k.yyx * e).x + k.yxy * scene(p + k.yxy * e).x + k.xxx * scene(p + k.xxx * e).x);
}
@fragment fn fs(i: FS) -> @location(0) vec4f {
  let ro = u.camPos.xyz;
  let rd = rayDir(i.pos.xy, u);
  let steps = i32(u.params.x);
  let pixel = u.res.w * 1.2;
  // bounding sphere r=1.25
  let b = dot(ro, rd); let cc = dot(ro, ro) - 1.5625; let disc = b * b - cc;
  var col = vec3f(0.0);
  // background: subtle spectrum halo
  let bg = 1.0 - abs(rd.y);
  col = hsv(u.t.z + 0.6, 0.6, 1.0) * pow(bg, 8.0) * 0.03;
  var glow = 0.0;
  if (disc > 0.0) {
    var t = max(-b - sqrt(disc), 0.0);
    let tEnd = -b + sqrt(disc);
    var hit = false; var trap = 0.0; var i2 = 0;
    for (var s = 0; s < steps; s++) {
      let p = ro + rd * t;
      let d = scene(p);
      glow += exp(-d.x * 60.0) * 0.005;
      if (d.x < pixel * t) { hit = true; trap = d.y; i2 = s; break; }
      t += d.x * 0.9;
      if (t > tEnd) { break; }
      i2 = s;
    }
    if (hit) {
      let p = ro + rd * t;
      let n = normal(p, pixel * t * 0.5);
      let l = normalize(vec3f(0.6, 0.8, 0.4));
      let dif = max(dot(n, l), 0.0);
      let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      let ao = 1.0 - f32(i2) / f32(steps);
      let band = spec[min(u32(clamp(trap * 0.9, 0.0, 1.0) * 200.0), 255u)];
      let base = hsv(u.t.z + trap * 0.45, 0.75, 1.0);
      col = base * (0.04 + dif * 0.55) * ao * ao;
      col += hsv(u.t.z + 0.5, 0.6, 1.0) * rim * (0.25 + u.audio.z * 1.0);
      col += base * band * band * band * 1.1 * (0.3 + u.audio.w);       // surface lights up with its frequency band
      let h = normalize(l - rd);
      col += vec3f(pow(max(dot(n, h), 0.0), 48.0)) * 0.8;
    }
  }
  col += hsv(u.t.z + 0.55, 0.7, 1.0) * glow * (0.3 + u.audio.x * 0.9);
  return vec4f(col, 1.0);
}
`;

const POST = /* wgsl */`
struct FS { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> FS {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: FS; o.pos = vec4f(p[i], 0.0, 1.0); o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5); return o;
}
struct PP { a: vec4f, b: vec4f };   // bright: a.x threshold | blur: a.xy texel step | composite: a = (bloom1, bloom2, exposure, vignette), b.x = time
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> pp: PP;
@group(0) @binding(3) var src2: texture_2d<f32>;
@group(0) @binding(4) var src3: texture_2d<f32>;
@fragment fn bright(i: FS) -> @location(0) vec4f {
  let c = textureSample(src, samp, i.uv).rgb;
  let l = max(c.r, max(c.g, c.b));
  let k = max(l - pp.a.x, 0.0) / max(l, 1e-4);
  return vec4f(c * k, 1.0);
}
@fragment fn blur(i: FS) -> @location(0) vec4f {
  let o1 = 1.3846153846; let o2 = 3.2307692308;
  var c = textureSample(src, samp, i.uv).rgb * 0.2270270270;
  c += textureSample(src, samp, i.uv + pp.a.xy * o1).rgb * 0.3162162162;
  c += textureSample(src, samp, i.uv - pp.a.xy * o1).rgb * 0.3162162162;
  c += textureSample(src, samp, i.uv + pp.a.xy * o2).rgb * 0.0702702703;
  c += textureSample(src, samp, i.uv - pp.a.xy * o2).rgb * 0.0702702703;
  return vec4f(c, 1.0);
}
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
@fragment fn composite(i: FS) -> @location(0) vec4f {
  let ca = (i.uv - 0.5) * 0.0025;
  var c = vec3f(textureSample(src, samp, i.uv + ca).r, textureSample(src, samp, i.uv).g, textureSample(src, samp, i.uv - ca).b);
  c += textureSample(src2, samp, i.uv).rgb * pp.a.x + textureSample(src3, samp, i.uv).rgb * pp.a.y;
  c = aces(c * pp.a.z);
  let q = i.uv - 0.5;
  c *= 1.0 - dot(q, q) * pp.a.w;
  c = pow(c, vec3f(1.0 / 2.2));
  let n = fract(sin(dot(i.pos.xy + pp.b.x, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += n / 255.0;
  return vec4f(c, 1.0);
}
`;

/* ------------------------------ audio features ------------------------------ */
class Features {
  constructor(analyser, chords) {
    this.an = analyser; this.chords = chords;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    this.data = new Float32Array(BINS * 2);          // spectrum + waveform
    const ny = analyser.context.sampleRate / 2, n = analyser.frequencyBinCount;
    this.bins = []; for (let i = 0; i <= BINS; i++) this.bins.push(Math.min(n - 1, Math.round(30 * Math.pow(16000 / 30, i / BINS) / ny * n)));
    Object.assign(this, { bass: 0, mid: 0, treb: 0, beat: 0, avg: 0, lastBeat: 0, hue: Math.random(), phase: 0 });
  }
  band(f0, f1) {
    const ny = this.an.context.sampleRate / 2, n = this.freq.length;
    const a = Math.max(1, Math.floor(f0 / ny * n)), b = Math.max(a + 1, Math.floor(f1 / ny * n));
    let s = 0; for (let i = a; i < b; i++) s += this.freq[i]; return s / (b - a) / 255;
  }
  update(now, dt, live) {
    const d = this.data;
    let tb = 0, tm = 0, tt = 0;
    if (live) {
      this.an.getByteFrequencyData(this.freq); this.an.getByteTimeDomainData(this.time);
      for (let i = 0; i < BINS; i++) {
        let m = 0; for (let j = this.bins[i]; j <= Math.max(this.bins[i], this.bins[i + 1] - 1); j++) if (this.freq[j] > m) m = this.freq[j];
        d[i] = Math.min(1, m / 255 * (0.85 + i / BINS * 0.55));
        d[BINS + i] = this.time[Math.floor(i / BINS * this.time.length)] / 128 - 1;
      }
      tb = this.band(25, 150); tm = this.band(150, 2000); tt = Math.min(1, this.band(2000, 9000) * 1.6);
    } else for (let i = 0; i < BINS; i++) { d[i] *= 0.93; d[BINS + i] *= 0.9; }
    const sm = (v, t, u, dn) => v + (t - v) * (t > v ? u : dn);
    this.bass = sm(this.bass, tb, .55, .09); this.mid = sm(this.mid, tm, .4, .07); this.treb = sm(this.treb, tt, .5, .1);
    this.avg += (this.bass - this.avg) * 0.02;
    let beat = false;
    if (this.bass > this.avg * 1.22 && this.bass > 0.32 && now - this.lastBeat > 260) { this.beat = 1; this.lastBeat = now; beat = true; }
    this.beat *= Math.pow(0.88, dt * 60);
    this.phase += dt * (0.3 + this.bass * 1.8);
    const c = this.chords;
    if (c) { c.update(now, dt, live, beat); this.hue = c.hue; this.spread = c.spread; this.sat = c.sat; }
    else { this.hue += dt * 0.012 + (beat ? 0.05 : 0); this.spread = 1; this.sat = 1; }
  }
}

/* ------------------------------ visualizer ------------------------------ */
export class GpuVisualizer {
  static supported() { return !!navigator.gpu; }

  static async create(canvas, analyser, opts = {}) {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const L = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize }
    });
    const v = new GpuVisualizer(canvas, analyser, adapter, device, opts);
    await v.build();
    return v;
  }

  constructor(canvas, analyser, adapter, device, opts) {
    this.canvas = canvas; this.adapter = adapter; this.device = device;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.f = new Features(analyser, opts.chords);
    this.preset = 0; this.qualityName = opts.quality || 'High';
    this.active = false; this.isPlaying = () => true;
    this.cam = { yaw: 0, pitch: 0.28, dist: 3.6, auto: true, dragging: false, lastInput: 0 };
    this.W = 0; this.H = 0; this.SW = 0; this.SH = 0;
    this.stats = { fps: 0, frames: 0, t0: performance.now(), gpuMs: 0 };
    this.histRow = 0; this.histAcc = 0;
    this.lost = false;
    device.lost.then(info => { this.lost = true; this.active = false; this.onLost?.(info); });
    this.frame = this.frame.bind(this);
    this.installControls();
  }
  get quality() { return QUALITY[this.qualityName]; }
  get adapterName() {
    const i = this.adapter.info || {};
    return [i.description || i.device, i.vendor, i.architecture].filter(Boolean).join(' · ') || 'GPU';
  }

  async build() {
    const d = this.device;
    const mod = code => d.createShaderModule({ code });
    this.uni = d.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uData = new Float32Array(64);
    this.specBuf = d.createBuffer({ size: BINS * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.histBuf = d.createBuffer({ size: HIST_ROWS * BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const HDR = 'rgba16float';
    const sim = mod(PARTICLE_SIM), pdraw = mod(PARTICLE_DRAW), terr = mod(TERRAIN), frac = mod(FRACTAL), post = mod(POST);
    const check = async (m, name) => {
      const info = await m.getCompilationInfo();
      const errs = info.messages.filter(x => x.type === 'error');
      if (errs.length) throw new Error(`${name} shader: ` + errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join('; '));
    };
    await Promise.all([check(sim, 'sim'), check(pdraw, 'particles'), check(terr, 'terrain'), check(frac, 'fractal'), check(post, 'post')]);

    const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    const P = {};
    P.init = d.createComputePipeline({ layout: 'auto', compute: { module: sim, entryPoint: 'init' } });
    P.step = d.createComputePipeline({ layout: 'auto', compute: { module: sim, entryPoint: 'simulate' } });
    P.pdraw = d.createRenderPipeline({ layout: 'auto', vertex: { module: pdraw, entryPoint: 'vs' },
      fragment: { module: pdraw, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] }, primitive: { topology: 'triangle-list' } });
    P.pbg = d.createRenderPipeline({ layout: 'auto', vertex: { module: pdraw, entryPoint: 'vsFull' },
      fragment: { module: pdraw, entryPoint: 'bg', targets: [{ format: HDR }] } });
    P.sky = d.createRenderPipeline({ layout: 'auto', vertex: { module: terr, entryPoint: 'vsFull' },
      fragment: { module: terr, entryPoint: 'sky', targets: [{ format: HDR }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' } });
    P.terrain = d.createRenderPipeline({ layout: 'auto', vertex: { module: terr, entryPoint: 'vs' },
      fragment: { module: terr, entryPoint: 'fs', targets: [{ format: HDR }] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } });
    P.fractal = d.createRenderPipeline({ layout: 'auto', vertex: { module: frac, entryPoint: 'vsFull' },
      fragment: { module: frac, entryPoint: 'fs', targets: [{ format: HDR }] } });
    const postPipe = (entry, fmt) => d.createRenderPipeline({ layout: 'auto', vertex: { module: post, entryPoint: 'vsFull' }, fragment: { module: post, entryPoint: entry, targets: [{ format: fmt }] } });
    P.bright = postPipe('bright', HDR); P.blur = postPipe('blur', HDR); P.comp = postPipe('composite', this.format);
    this.P = P;
    this.ppBufs = Array.from({ length: 6 }, () => d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.terrainBG = d.createBindGroup({ layout: P.terrain.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.histBuf } }] });
    this.skyBG = d.createBindGroup({ layout: P.sky.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uni } }] });
    this.fracBG = d.createBindGroup({ layout: P.fractal.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.specBuf } }] });
    this.pbgBG = d.createBindGroup({ layout: P.pbg.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uni } }] });
    this.allocParticles();
  }

  allocParticles() {
    const d = this.device;
    const maxCount = Math.floor(Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize) / 32);
    this.count = Math.min(this.quality.particles, maxCount);
    this.pBuf?.destroy();
    this.pBuf = d.createBuffer({ size: this.count * 32, usage: GPUBufferUsage.STORAGE });
    this.simBG = d.createBindGroup({ layout: this.P.step.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.specBuf } }, { binding: 2, resource: { buffer: this.pBuf } }] });
    this.initBG = d.createBindGroup({ layout: this.P.init.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.specBuf } }, { binding: 2, resource: { buffer: this.pBuf } }] });
    this.drawBG = d.createBindGroup({ layout: this.P.pdraw.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uni } }, { binding: 1, resource: { buffer: this.pBuf } }] });
    this.needInit = true;
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    this.qualityName = name;
    this.allocParticles();
    this.W = 0;   // force target re-allocation at the new render scale
  }
  setPreset(i) { this.preset = ((i % GPU_PRESETS.length) + GPU_PRESETS.length) % GPU_PRESETS.length; this.cam.auto = true; }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h; this.canvas.width = w; this.canvas.height = h;
    const s = this.quality.scale;
    const SW = this.SW = Math.max(2, Math.floor(w * s)), SH = this.SH = Math.max(2, Math.floor(h * s));
    const d = this.device;
    const tex = (w2, h2, fmt = 'rgba16float', usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING) =>
      d.createTexture({ size: [Math.max(1, w2), Math.max(1, h2)], format: fmt, usage });
    for (const t of [this.scene, this.depth, this.b1a, this.b1b, this.b2a, this.b2b]) t?.destroy();
    this.scene = tex(SW, SH);
    this.depth = tex(SW, SH, 'depth24plus', GPUTextureUsage.RENDER_ATTACHMENT);
    this.b1a = tex(SW >> 1, SH >> 1); this.b1b = tex(SW >> 1, SH >> 1);
    this.b2a = tex(SW >> 2, SH >> 2); this.b2b = tex(SW >> 2, SH >> 2);
    const bg = (pipe, srcTex, buf, extra = []) => d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.sampler }, { binding: 1, resource: srcTex.createView() }, { binding: 2, resource: { buffer: buf } }, ...extra] });
    const B = this.ppBufs;
    this.postBG = {
      bright: bg(this.P.bright, this.scene, B[0]),
      b1h: bg(this.P.blur, this.b1a, B[1]), b1v: bg(this.P.blur, this.b1b, B[2]),
      b2h: bg(this.P.blur, this.b2a, B[3]), b2v: bg(this.P.blur, this.b2b, B[4]),
      down: bg(this.P.blur, this.b1a, B[3]),
      comp: bg(this.P.comp, this.scene, B[5], [{ binding: 3, resource: this.b1a.createView() }, { binding: 4, resource: this.b2a.createView() }])
    };
    const w1 = SW >> 1, h1 = SH >> 1, w2 = SW >> 2, h2 = SH >> 2;
    const q = (buf, a0, a1 = 0, a2 = 0, a3 = 0) => d.queue.writeBuffer(buf, 0, new Float32Array([a0, a1, a2, a3, 0, 0, 0, 0]));
    q(B[1], 1 / Math.max(1, w1), 0); q(B[2], 0, 1 / Math.max(1, h1));
    q(B[3], 1 / Math.max(1, w2), 0); q(B[4], 0, 1 / Math.max(1, h2));
  }

  installControls() {
    const c = this.canvas, cam = this.cam;
    let px = 0, py = 0;
    c.addEventListener('pointerdown', e => { cam.dragging = true; cam.auto = false; px = e.clientX; py = e.clientY; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!cam.dragging) return;
      cam.yaw -= (e.clientX - px) * 0.006; cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch + (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY; cam.lastInput = performance.now();
    });
    const up = () => { cam.dragging = false; cam.lastInput = performance.now(); };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); cam.dist = Math.max(1.4, Math.min(9, cam.dist * Math.exp(e.deltaY * 0.001))); cam.lastInput = performance.now(); }, { passive: false });
  }

  start() { if (this.active || this.lost) return; this.active = true; this.tPrev = performance.now(); requestAnimationFrame(this.frame); }
  stop() { this.active = false; }

  camera(now, dt) {
    const f = this.f, cam = this.cam, aspect = this.SW / this.SH;
    if (!cam.auto && !cam.dragging && now - cam.lastInput > 8000) cam.auto = true;
    if (cam.auto) cam.yaw += dt * (0.08 + f.mid * 0.25);
    let eye, target, fov = 0.9;
    if (this.preset === 1) {          // terrain: low flight, gentle orbit offset
      const sway = Math.sin(now * 0.00013) * 0.5 + Math.sin(cam.yaw) * 0.6;
      eye = [sway, 0.95 + f.bass * 0.15 + cam.pitch * 0.8, 2.6 + (cam.dist - 3.6) * 0.5];
      target = [sway * 0.4, 0.55, -6];
      fov = 1.0;
    } else {
      const dist = (this.preset === 2 ? cam.dist * 0.78 : cam.dist) * (1 - f.bass * 0.06);
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      eye = [Math.sin(cam.yaw) * cp * dist, sp * dist, Math.cos(cam.yaw) * cp * dist];
      target = [0, 0, 0];
      fov = this.preset === 2 ? 0.75 : 0.95;
    }
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective(fov, aspect, 0.03, 120);
    const vp = mul(proj, view);
    return { vp, inv: invert(vp), eye };
  }

  frame(now) {
    if (!this.active) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.tPrev) / 1000); this.tPrev = now;
    this.resize();
    const f = this.f; f.update(now, dt, this.isPlaying());
    const d = this.device, q = this.quality;
    // spectrogram history for the terrain
    this.histAcc += dt;
    const ROW_DT = 1 / 40;
    while (this.histAcc >= ROW_DT) {
      this.histAcc -= ROW_DT;
      this.histRow = (this.histRow + 1) % HIST_ROWS;
      d.queue.writeBuffer(this.histBuf, this.histRow * BINS * 4, f.data, 0, BINS);
    }
    d.queue.writeBuffer(this.specBuf, 0, f.data);

    const { vp, inv, eye } = this.camera(now, dt);
    const U = this.uData;
    U.set(vp, 0); U.set(inv, 16);
    U.set([eye[0], eye[1], eye[2], this.histAcc / ROW_DT], 32);
    U.set([this.SW, this.SH, 1 / this.SW, 1 / this.SH], 36);
    U.set([f.bass, f.mid, f.treb, f.beat], 40);
    U.set([now / 1000, dt, f.hue % 1, f.phase], 44);
    const brightness = Math.min(2, 0.018 * (1048576 / this.count) * Math.pow(this.SW * this.SH / (1920 * 1080), 0.5));
    if (this.preset === 0) U.set([this.count, Math.max(0.9, this.SW / 1600), brightness, 0], 48);
    else if (this.preset === 1) U.set([0, 0, 0, this.histRow], 48);
    else U.set([q.steps, 0, 0, 0], 48);
    U.set([0, f.spread, 0, f.sat], 52);
    d.queue.writeBuffer(this.uni, 0, U);

    const enc = d.createCommandEncoder();
    const sceneView = this.scene.createView();
    if (this.preset === 0) {
      const wg = Math.ceil(this.count / 256);
      const cp = enc.beginComputePass();
      if (this.needInit) { cp.setPipeline(this.P.init); cp.setBindGroup(0, this.initBG); cp.dispatchWorkgroups(wg); this.needInit = false; }
      cp.setPipeline(this.P.step); cp.setBindGroup(0, this.simBG); cp.dispatchWorkgroups(wg); cp.end();
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: sceneView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline(this.P.pbg); rp.setBindGroup(0, this.pbgBG); rp.draw(3);
      rp.setPipeline(this.P.pdraw); rp.setBindGroup(0, this.drawBG); rp.draw(6, this.count);
      rp.end();
    } else if (this.preset === 1) {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: sceneView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 } });
      rp.setPipeline(this.P.sky); rp.setBindGroup(0, this.skyBG); rp.draw(3);
      rp.setPipeline(this.P.terrain); rp.setBindGroup(0, this.terrainBG); rp.draw((192 - 1) * (HIST_ROWS - 1) * 6);
      rp.end();
    } else {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: sceneView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline(this.P.fractal); rp.setBindGroup(0, this.fracBG); rp.draw(3); rp.end();
    }

    // post: bright → blur(½) → down → blur(¼) → composite
    const look = [[0.12, 0.9, 1.15], [0.6, 0.6, 1.0], [0.6, 0.55, 1.0]][this.preset];   // threshold, bloom, exposure
    d.queue.writeBuffer(this.ppBufs[0], 0, new Float32Array([look[0], 0, 0, 0, 0, 0, 0, 0]));
    d.queue.writeBuffer(this.ppBufs[5], 0, new Float32Array([look[1] * 0.6, look[1] * 0.9, look[2] * (1 + f.beat * 0.15), 0.9, (now % 1000), 0, 0, 0]));
    const pass = (view, pipe, bgp) => {
      const p = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(pipe); p.setBindGroup(0, bgp); p.draw(3); p.end();
    };
    pass(this.b1a.createView(), this.P.bright, this.postBG.bright);
    pass(this.b1b.createView(), this.P.blur, this.postBG.b1h);
    pass(this.b1a.createView(), this.P.blur, this.postBG.b1v);
    pass(this.b2a.createView(), this.P.blur, this.postBG.down);
    pass(this.b2b.createView(), this.P.blur, this.postBG.b2h);
    pass(this.b2a.createView(), this.P.blur, this.postBG.b2v);
    pass(this.ctx.getCurrentTexture().createView(), this.P.comp, this.postBG.comp);
    d.queue.submit([enc.finish()]);

    const s = this.stats; s.frames++;
    if (now - s.t0 >= 500) { s.fps = s.frames * 1000 / (now - s.t0); s.frames = 0; s.t0 = now; this.onStats?.(this.statsText()); }
  }
  statsText() {
    const what = this.preset === 0 ? `${(this.count / 1e6).toFixed(2)}M particles` : this.preset === 1 ? `${191 * 127 * 2} triangles` : `${this.quality.steps} ray steps`;
    return `${this.stats.fps.toFixed(0)} fps · ${what} · ${this.SW}×${this.SH} · ${this.qualityName} · ${this.adapterName}`;
  }
}
