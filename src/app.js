import { Engine, EQ_FREQS } from './engine.js';
import { Visualizer } from './visualizer.js';

const api = window.pulse;
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs = {}, html) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  if (html != null) el.innerHTML = html;
  return el;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('pulse.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pulse.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a || '', b || '');

/* ================================ icons ================================ */
const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M14.8 4H20v5.2l-2-2-3.6 3.6-1.4-1.4L16.6 6zM4 5.4 5.4 4 20 18.6 18.6 20zM20 14.8V20h-5.2l2-2-3-3 1.4-1.4 3 3z"/></svg>',
  queueAdd: '<svg viewBox="0 0 24 24"><path d="M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-3h2v3h3v2h-3v3h-2v-3h-3v-2h3z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zM18.7 8.1a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0l-1.1 1.1 2.8 2.8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
  repeat: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/>',
  volOn: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>',
  volLow: '<path d="M5 9v6h4l5 5V4L9 9H5zm13.5 3A4.5 4.5 0 0 0 16 8v8a4.5 4.5 0 0 0 2.5-4z"/>',
  volOff: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/>'
};

/* ================================ state ================================ */
const S = {
  tracks: [], byId: new Map(), albums: [], albumByKey: new Map(), artists: [], artistByName: new Map(),
  folders: [], playlists: [], view: store.get('view', { name: 'albums' }), query: '',
  songSort: store.get('songSort', 'artist'), albumSort: store.get('albumSort', 'artist'),
  selected: null, virtualDraw: null, history: []
};
const Q = { ids: [], order: [], pos: -1, shuffle: false, repeat: 'off', restoreAt: 0 };

const engine = new Engine();
const artUrl = a => a ? `pulse://app/art/${encodeURIComponent(a)}` : null;
const fmtTime = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
const srK = sr => (sr / 1000).toFixed(1).replace(/\.0$/, '');
const isHiRes = t => (t.bits && t.bits > 16) || (t.sampleRate && t.sampleRate > 48000);
function fmtShort(t) {
  if (t.lossless && t.bits && t.sampleRate) return `${t.codec} ${t.bits}/${srK(t.sampleRate)}`;
  if (t.bitrate) return `${t.codec} ${Math.round(t.bitrate / 1000)}k`;
  return t.codec || '';
}
function fmtLongFormat(t) {
  if (t.lossless && t.bits && t.sampleRate) return `${t.codec} · ${t.bits}-bit / ${srK(t.sampleRate)} kHz`;
  return [t.codec, t.bitrate && `${Math.round(t.bitrate / 1000)} kbps`, t.sampleRate && `${srK(t.sampleRate)} kHz`].filter(Boolean).join(' · ');
}
function initials(s) { return (s || '?').replace(/^the\s+/i, '').trim().slice(0, 1).toUpperCase(); }
function hueOf(s) { let x = 0; for (const c of s || '') x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; }
function coverHTML(art, name, extra = '') {
  return art ? `<img loading="lazy" decoding="async" src="${artUrl(art)}" alt="">${extra}`
    : `<div class="ph" style="background:linear-gradient(135deg,hsl(${hueOf(name)} 40% 28%),hsl(${(hueOf(name) + 60) % 360} 45% 16%))">${esc(initials(name))}</div>${extra}`;
}

/* ================================ library ================================ */
async function loadLibrary() {
  const r = await api.getLibrary();
  S.folders = r.folders;
  document.body.classList.toggle('mac', r.platform === 'darwin');
  buildIndex(r.tracks);
  $('#libCount').textContent = S.tracks.length ? `${S.tracks.length.toLocaleString()} tracks · ${S.folders.length} folder${S.folders.length === 1 ? '' : 's'}` : 'Library folders';
}
function buildIndex(tracks) {
  S.tracks = tracks;
  S.byId = new Map(tracks.map(t => [t.id, t]));
  const albums = new Map();
  for (const t of tracks) {
    let a = albums.get(t.albumKey);
    if (!a) albums.set(t.albumKey, a = { key: t.albumKey, title: t.album, artist: t.albumArtist, year: t.year, art: t.art, ids: [], duration: 0, bits: 0, sr: 0, codecs: new Set() });
    a.ids.push(t.id); a.duration += t.duration || 0;
    if (!a.art && t.art) a.art = t.art;
    if (!a.year && t.year) a.year = t.year;
    if (t.bits > a.bits) a.bits = t.bits;
    if (t.sampleRate > a.sr) a.sr = t.sampleRate;
    a.codecs.add(t.codec);
  }
  for (const a of albums.values()) {
    a.ids.sort((x, y) => { const p = S.byId.get(x), q = S.byId.get(y);
      return (p.disc || 1) - (q.disc || 1) || (p.track || 999) - (q.track || 999) || cmp(p.title, q.title); });
    a.hires = a.bits > 16 || a.sr > 48000;
    a.multiDisc = new Set(a.ids.map(id => S.byId.get(id).disc || 1)).size > 1;
  }
  S.albums = [...albums.values()];
  S.albumByKey = albums;
  sortAlbums();
  const artists = new Map();
  for (const a of S.albums) {
    let ar = artists.get(a.artist.toLowerCase());
    if (!ar) artists.set(a.artist.toLowerCase(), ar = { name: a.artist, albums: [], count: 0, art: null });
    ar.albums.push(a.key); ar.count += a.ids.length; if (!ar.art && a.art) ar.art = a.art;
  }
  S.artists = [...artists.values()].sort((a, b) => cmp(a.name.replace(/^the /i, ''), b.name.replace(/^the /i, '')));
  S.artistByName = artists;
}
function sortAlbums() {
  const by = S.albumSort;
  const strip = s => (s || '').replace(/^the /i, '');
  S.albums.sort(by === 'title' ? (a, b) => cmp(a.title, b.title)
    : by === 'year' ? (a, b) => (b.year || 0) - (a.year || 0) || cmp(a.title, b.title)
    : (a, b) => cmp(strip(a.artist), strip(b.artist)) || (a.year || 0) - (b.year || 0) || cmp(a.title, b.title));
}
const albumOf = t => S.albumByKey.get(t.albumKey);
const artistAlbums = name => (S.artistByName.get((name || '').toLowerCase())?.albums || []).map(k => S.albumByKey.get(k))
  .sort((a, b) => (a.year || 0) - (b.year || 0) || cmp(a.title, b.title));

/* ================================ queue ================================ */
const curTrack = () => (Q.pos >= 0 && Q.pos < Q.order.length) ? S.byId.get(Q.ids[Q.order[Q.pos]]) : null;
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function buildOrder(startIdx) {
  const n = Q.ids.length;
  Q.order = [...Array(n).keys()];
  if (Q.shuffle && n) {
    shuffleArr(Q.order);
    const k = Q.order.indexOf(startIdx); if (k > 0) [Q.order[0], Q.order[k]] = [Q.order[k], Q.order[0]];
    Q.pos = 0;
  } else Q.pos = Math.max(0, Math.min(startIdx, n - 1));
}
function peekPos(auto) {
  if (!Q.order.length || Q.pos < 0) return -1;
  if (auto && Q.repeat === 'one') return Q.pos;
  if (Q.pos + 1 < Q.order.length) return Q.pos + 1;
  return Q.repeat === 'all' ? 0 : -1;
}
engine.getNext = () => { const p = peekPos(true); return p < 0 ? null : S.byId.get(Q.ids[Q.order[p]]) || null; };

function playList(ids, idx = 0, shuffle = null) {
  ids = ids.filter(id => S.byId.has(id));
  if (!ids.length) return;
  if (shuffle != null) Q.shuffle = shuffle;
  Q.ids = [...ids];
  buildOrder(shuffle ? Math.floor(Math.random() * ids.length) : idx);
  playCurrent();
  updateShuffleRepeat();
}
function playCurrent(offset = 0, autoplay = true) {
  const t = curTrack(); if (!t) return;
  Q.restoreAt = 0;
  engine.play(t, offset, autoplay);
  saveQueue();
}
function playNext(ids) {
  if (!Q.ids.length || Q.pos < 0) return playList(ids);
  const base = Q.ids.length; Q.ids.push(...ids);
  Q.order.splice(Q.pos + 1, 0, ...ids.map((_, i) => base + i));
  afterQueueChange(`Playing next: ${ids.length === 1 ? S.byId.get(ids[0])?.title : ids.length + ' tracks'}`);
}
function addToQueue(ids) {
  if (!Q.ids.length || Q.pos < 0) return playList(ids);
  const base = Q.ids.length; Q.ids.push(...ids);
  Q.order.push(...ids.map((_, i) => base + i));
  afterQueueChange(`Added ${ids.length === 1 ? '“' + S.byId.get(ids[0])?.title + '”' : ids.length + ' tracks'} to queue`);
}
function removeFromQueue(p) {
  const idx = Q.order[p];
  Q.order.splice(p, 1); Q.ids.splice(idx, 1);
  Q.order = Q.order.map(i => i > idx ? i - 1 : i);
  if (p < Q.pos) Q.pos--;
  else if (p === Q.pos) {
    if (Q.pos >= Q.order.length) Q.pos = Q.order.length - 1;
    if (Q.pos >= 0) playCurrent(0, engine.playing); else { engine.stop(); updateNowPlaying(); }
  }
  afterQueueChange();
}
function moveInQueue(from, to) {
  if (from === to) return;
  const [x] = Q.order.splice(from, 1);
  if (to > from) to--;
  Q.order.splice(to, 0, x);
  if (Q.pos === from) Q.pos = to;
  else if (from < Q.pos && to >= Q.pos) Q.pos--;
  else if (from > Q.pos && to <= Q.pos) Q.pos++;
  afterQueueChange();
}
function afterQueueChange(msg) {
  engine.invalidateNext();
  saveQueue();
  if (S.view.name === 'queue') render();
  if (msg) toast(msg);
}
function next() {
  if (!Q.order.length) return;
  if (Q.pos + 1 < Q.order.length) Q.pos++;
  else if (Q.repeat !== 'off') Q.pos = 0;
  else return;
  playCurrent(0, true);
}
function prev() {
  if (!Q.order.length) return;
  if (engine.position > 3 || (Q.pos === 0 && Q.repeat === 'off')) { if (engine.track) engine.seek(0); else playCurrent(); return; }
  Q.pos = Q.pos > 0 ? Q.pos - 1 : Q.order.length - 1;
  playCurrent(0, true);
}
function togglePlay() {
  if (engine.track) return engine.toggle();
  if (curTrack()) return playCurrent(Q.restoreAt || 0, true);
  if (S.tracks.length) playList(currentListIds(), 0);
}
function toggleShuffle() {
  const cur = Q.order[Q.pos];
  Q.shuffle = !Q.shuffle;
  if (Q.ids.length) {
    if (Q.shuffle) { const rest = shuffleArr(Q.order.filter((_, i) => i !== Q.pos)); Q.order = [cur, ...rest]; Q.pos = 0; }
    else { Q.order = [...Array(Q.ids.length).keys()]; Q.pos = cur ?? 0; }
  }
  updateShuffleRepeat(); afterQueueChange(Q.shuffle ? 'Shuffle on' : 'Shuffle off');
}
function cycleRepeat() {
  Q.repeat = { off: 'all', all: 'one', one: 'off' }[Q.repeat];
  updateShuffleRepeat(); afterQueueChange({ off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' }[Q.repeat]);
}
let saveQT;
function saveQueue() {
  clearTimeout(saveQT);
  saveQT = setTimeout(() => store.set('queue', { ids: Q.ids, order: Q.order, pos: Q.pos, shuffle: Q.shuffle, repeat: Q.repeat, at: engine.track ? engine.position : Q.restoreAt }), 400);
}
function restoreQueue() {
  const q = store.get('queue', null); if (!q || !q.ids?.length) return;
  if (q.ids.length !== q.order.length) return;
  Object.assign(Q, { ids: q.ids, order: q.order, pos: q.pos, shuffle: !!q.shuffle, repeat: q.repeat || 'off', restoreAt: q.at || 0 });
  updateShuffleRepeat(); updateNowPlaying();
}

/* ================================ engine events ================================ */
engine.addEventListener('track', e => {
  if (e.detail.auto) { const p = peekPos(true); if (p >= 0) Q.pos = p; }
  updateNowPlaying(); markPlaying(); saveQueue();
  if (S.view.name === 'queue') render();
});
engine.addEventListener('advance', () => { const p = peekPos(true); if (p >= 0) { Q.pos = p; playCurrent(0, true); } });
engine.addEventListener('state', () => updatePlayState());
engine.addEventListener('ended', () => { updatePlayState(); });
engine.addEventListener('loading', e => { $('#npTitle').textContent = e.detail.title; });
engine.addEventListener('error', e => { toast(`${e.detail.message}: ${e.detail.track.title}`); });
engine.addEventListener('rg', () => updateNowPlaying());

/* ================================ now playing bar ================================ */
function updatePlayState() {
  const p = engine.playing;
  $('#playIcon').innerHTML = p ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  $('#playBtn').title = p ? 'Pause (Space)' : 'Play (Space)';
  document.body.classList.toggle('paused', !p);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
}
function updateNowPlaying() {
  const t = engine.track || curTrack();
  $('#npArt').innerHTML = t ? coverHTML(t.art, t.album) : '';
  $('#npTitle').textContent = t ? t.title : 'Not playing';
  $('#npArtist').textContent = t ? `${t.artist} — ${t.album}` : '';
  const b = $('#npBadges'); b.innerHTML = '';
  if (t) {
    b.append(h('span', { class: 'badge' + (isHiRes(t) ? ' hi' : ''), title: fmtLongFormat(t) + `\nOutput: ${srK(engine.ctx.sampleRate)} kHz` }, esc(fmtShort(t))));
    const rg = engine.rgInfo(t);
    if (rg) b.append(h('span', { class: 'badge rg', title: rg.tagged ? `ReplayGain (${engine.rg.mode})` : 'No ReplayGain tags — using fallback gain' },
      `RG ${rg.db >= 0 ? '+' : '−'}${Math.abs(rg.db).toFixed(1)} dB${rg.tagged ? '' : '*'}`));
    document.title = `${t.title} — ${t.artist}`;
  } else document.title = 'Pulse';
  $('#vizTitle').textContent = t ? t.title : '';
  $('#vizSub').textContent = t ? `${t.artist} — ${t.album}` : '';
  $('#vizArt').innerHTML = t ? coverHTML(t.art, t.album) : '';
  if ('mediaSession' in navigator && t) setSessionMeta(t);
  updatePlayState();
}
// The OS media overlay only accepts http/data/blob artwork, so convert cover art to blob URLs.
const artBlobs = new Map();
async function setSessionMeta(t) {
  let src = null;
  if (t.art) {
    src = artBlobs.get(t.art);
    if (!src) { try { src = URL.createObjectURL(await (await fetch(artUrl(t.art))).blob()); artBlobs.set(t.art, src); } catch { src = null; } }
  }
  if ((engine.track || curTrack()) !== t) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: src ? [{ src, sizes: '512x512' }] : [] }); } catch { /* ignore */ }
}
function updateShuffleRepeat() {
  $('#shuffleBtn').classList.toggle('on', Q.shuffle);
  $('#repeatBtn').classList.toggle('on', Q.repeat !== 'off');
  $('#repeatIcon').innerHTML = I.repeat;
  $('#repeatBtn').querySelector('.one')?.remove();
  if (Q.repeat === 'one') $('#repeatBtn').append(h('span', { class: 'one' }, '1'));
  $('#repeatBtn').title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[Q.repeat];
}
const paint = el => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
let seeking = false;
function tick() {
  const d = engine.track ? engine.duration : (curTrack()?.duration || 0);
  const p = engine.track ? engine.position : Q.restoreAt;
  if (!seeking) {
    $('#tCur').textContent = fmtTime(p); $('#tDur').textContent = fmtTime(d);
    const s = $('#seek'); s.value = d ? (p / d) * 1000 : 0; paint(s);
  }
  if ('mediaSession' in navigator && engine.track && d) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: 1 }); } catch { /* ignore */ }
  }
}
setInterval(tick, 250);
setInterval(() => { if (engine.playing) saveQueue(); }, 5000);

/* ================================ track table ================================ */
const COLS = { num: '40px', title: 'minmax(180px,2.2fr)', artist: 'minmax(110px,1.2fr)', album: 'minmax(110px,1.2fr)', fmt: '92px', dur: '56px', rm: '28px' };
const COL_LABEL = { num: '#', title: 'Title', artist: 'Artist', album: 'Album', fmt: 'Format', dur: 'Time', rm: '' };
const ROW = 40;

function trackTable(ids, opts = {}) {
  const cols = opts.cols || ['num', 'title', 'artist', 'album', 'fmt', 'dur'];
  const el = h('div', { class: 'tt' });
  el.style.setProperty('--cols', cols.map(c => COLS[c]).join(' '));
  const head = h('div', { class: 'tt-head' });
  for (const c of cols) {
    const cell = h('div', { style: c === 'num' || c === 'dur' || c === 'fmt' ? 'text-align:right' : null }, COL_LABEL[c]);
    if (opts.onSort && ['title', 'artist', 'album', 'dur', 'fmt'].includes(c)) { cell.classList.add('sortable'); cell.onclick = () => opts.onSort(c); }
    head.append(cell);
  }
  const body = h('div', { class: 'tt-body' });
  el.append(head, body);

  const rowEl = i => {
    const id = ids[i], t = S.byId.get(id);
    const r = h('div', { class: 'tr' + (t ? '' : ' missing'), 'data-i': i, 'data-id': id, draggable: 'true' });
    if (opts.queue) r.dataset.qpos = i;
    if (!t) { r.innerHTML = cols.map(c => c === 'title' ? '<div>Missing file</div>' : c === 'rm' ? `<div><button class="rm" title="Remove">${I.x}</button></div>` : '<div></div>').join(''); return r; }
    r.innerHTML = cols.map(c => {
      switch (c) {
        case 'num': return `<div class="c-num"><span class="n">${opts.trackNums ? (t.track || '') : i + 1}</span><span class="bars"><i></i><i></i><i></i></span></div>`;
        case 'title': return `<div class="c-title">${opts.thumbs ? (t.art ? `<img loading="lazy" src="${artUrl(t.art)}">` : '<div class="thumb"></div>') : ''}<div class="tw"><div class="t1">${esc(t.title)}</div>${opts.artistUnder ? `<div class="t2">${esc(t.artist)}</div>` : ''}</div></div>`;
        case 'artist': return `<div><span class="lnk" data-artist="${esc(t.artist)}">${esc(t.artist)}</span></div>`;
        case 'album': return `<div><span class="lnk" data-album="${esc(t.albumKey)}">${esc(t.album)}</span></div>`;
        case 'fmt': return `<div class="c-fmt${isHiRes(t) ? ' hi' : ''}" title="${esc(fmtLongFormat(t))}">${esc(fmtShort(t))}</div>`;
        case 'dur': return `<div class="c-dur">${fmtTime(t.duration)}</div>`;
        case 'rm': return `<div><button class="rm" title="Remove">${I.x}</button></div>`;
      }
      return '<div></div>';
    }).join('');
    if (S.selected === id + ':' + i) r.classList.add('sel');
    return r;
  };

  const virtual = ids.length > 160;
  if (!virtual) {
    let disc = null;
    ids.forEach((id, i) => {
      const t = S.byId.get(id);
      if (opts.discs && t && t.disc !== disc) { disc = t.disc; body.append(h('div', { class: 'disc' }, `Disc ${disc || 1}`)); }
      body.append(rowEl(i));
    });
  } else {
    body.classList.add('virtual');
    body.style.height = ids.length * ROW + 'px';
    let drawn = { s: -1, e: -1 };
    const draw = force => {
      if (!body.isConnected) return;
      const main = $('#main');
      const top = body.getBoundingClientRect().top - main.getBoundingClientRect().top;
      const s = Math.max(0, Math.floor(-top / ROW) - 8);
      const e = Math.min(ids.length, Math.ceil((-top + main.clientHeight) / ROW) + 8);
      if (!force && s === drawn.s && e === drawn.e) return;
      drawn = { s, e };
      const frag = document.createDocumentFragment();
      for (let i = s; i < e; i++) { const r = rowEl(i); r.style.transform = `translateY(${i * ROW}px)`; frag.append(r); }
      body.replaceChildren(frag);
      markPlaying();
    };
    S.virtualDraw = draw;
    requestAnimationFrame(() => draw(true));
  }

  // interactions (delegated)
  const rowOf = e => e.target.closest('.tr');
  body.addEventListener('click', e => {
    const lnk = e.target.closest('.lnk');
    if (lnk) { if (lnk.dataset.artist) go({ name: 'artist', id: lnk.dataset.artist }); else go({ name: 'album', id: lnk.dataset.album }); return; }
    const r = rowOf(e); if (!r) return;
    if (e.target.closest('.rm')) { opts.onRemove?.(+r.dataset.i); return; }
    $$('.tr.sel').forEach(x => x.classList.remove('sel'));
    r.classList.add('sel'); S.selected = r.dataset.id + ':' + r.dataset.i;
  });
  body.addEventListener('dblclick', e => {
    const r = rowOf(e); if (!r || e.target.closest('.lnk,.rm')) return;
    const i = +r.dataset.i;
    if (opts.onPlay) opts.onPlay(i); else playList(ids, i, false);
  });
  body.addEventListener('contextmenu', e => {
    const r = rowOf(e); if (!r) return;
    e.preventDefault();
    const i = +r.dataset.i;
    trackMenu(e.clientX, e.clientY, [ids[i]], { onRemove: opts.onRemove ? () => opts.onRemove(i) : null, removeLabel: opts.removeLabel,
      onPlay: () => opts.onPlay ? opts.onPlay(i) : playList(ids, i, false) });
  });
  body.addEventListener('dragstart', e => {
    const r = rowOf(e); if (!r) return;
    e.dataTransfer.setData('application/x-pulse', JSON.stringify({ ids: [r.dataset.id], from: +r.dataset.i, src: opts.dragSrc || null }));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  if (opts.onMove) {
    let over = null;
    const clear = () => { over?.classList.remove('drop-before', 'drop-after'); over = null; };
    body.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('application/x-pulse')) return;
      const r = rowOf(e); if (!r) return;
      e.preventDefault();
      const after = e.offsetY > r.clientHeight / 2 || (e.clientY - r.getBoundingClientRect().top) > r.clientHeight / 2;
      if (over !== r) clear();
      over = r; r.classList.toggle('drop-after', after); r.classList.toggle('drop-before', !after);
    });
    body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) clear(); });
    body.addEventListener('drop', e => {
      const raw = e.dataTransfer.getData('application/x-pulse'); const r = rowOf(e);
      if (!raw || !r) return clear();
      e.preventDefault();
      const d = JSON.parse(raw);
      let to = +r.dataset.i + (r.classList.contains('drop-after') ? 1 : 0);
      clear();
      if (d.src === opts.dragSrc) opts.onMove(d.from, to);
      else opts.onInsert?.(d.ids, to);
    });
  }
  return el;
}
const $$ = s => [...document.querySelectorAll(s)];
function markPlaying() {
  const id = engine.track?.id;
  for (const r of $$('.tr')) {
    const on = r.dataset.id === id && (r.dataset.qpos == null || +r.dataset.qpos === Q.pos);
    r.classList.toggle('playing', on);
  }
}

/* ================================ context menu ================================ */
function closeMenu() { $('#menu').classList.add('hidden'); }
function showMenu(x, y, items) {
  const m = $('#menu'); m.innerHTML = '';
  const build = (list, parent) => {
    for (const it of list) {
      if (it === '-') { parent.append(h('div', { class: 'sep' })); continue; }
      if (!it) continue;
      const mi = h('div', { class: 'mi' }, `<span>${esc(it.label)}</span>${it.sub ? '<span>›</span>' : ''}`);
      if (it.sub) { const sub = h('div', { class: 'sub' }); build(it.sub, sub); mi.append(sub); }
      else mi.onclick = () => { closeMenu(); it.fn(); };
      parent.append(mi);
    }
  };
  build(items, m);
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  if (x + r.width + 200 > innerWidth) m.querySelectorAll('.sub').forEach(s => s.classList.add('left'));
}
addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });
addEventListener('blur', closeMenu);

function playlistSub(ids) {
  return [
    { label: 'New playlist…', fn: () => newPlaylist(ids) },
    S.playlists.length ? '-' : null,
    ...S.playlists.map(p => ({ label: p.name, fn: () => addToPlaylist(p.id, ids) }))
  ];
}
function trackMenu(x, y, ids, o = {}) {
  const t = S.byId.get(ids[0]);
  showMenu(x, y, [
    o.onPlay && { label: 'Play', fn: o.onPlay },
    { label: 'Play next', fn: () => playNext(ids) },
    { label: 'Add to queue', fn: () => addToQueue(ids) },
    { label: 'Add to playlist', sub: playlistSub(ids) },
    '-',
    t && { label: 'Go to album', fn: () => go({ name: 'album', id: t.albumKey }) },
    t && { label: 'Go to artist', fn: () => go({ name: 'artist', id: t.albumArtist }) },
    t && { label: process_platform() === 'darwin' ? 'Show in Finder' : 'Show in folder', fn: () => api.reveal(t.id) },
    o.onRemove && '-',
    o.onRemove && { label: o.removeLabel || 'Remove', fn: o.onRemove }
  ]);
}
const process_platform = () => document.body.classList.contains('mac') ? 'darwin' : 'other';
function albumMenu(x, y, a) {
  showMenu(x, y, [
    { label: 'Play', fn: () => playList(a.ids, 0, false) },
    { label: 'Shuffle', fn: () => playList(a.ids, 0, true) },
    { label: 'Play next', fn: () => playNext(a.ids) },
    { label: 'Add to queue', fn: () => addToQueue(a.ids) },
    { label: 'Add to playlist', sub: playlistSub(a.ids) },
    '-',
    { label: 'Go to artist', fn: () => go({ name: 'artist', id: a.artist }) }
  ]);
}

/* ================================ playlists ================================ */
async function loadPlaylists() { S.playlists = await api.getPlaylists() || []; renderPlaylists(); }
const savePlaylists = () => { api.savePlaylists(S.playlists); renderPlaylists(); };
const uid = () => Math.random().toString(36).slice(2, 10);
function newPlaylist(ids = []) {
  promptModal('New playlist', 'Playlist name', `Playlist ${S.playlists.length + 1}`, name => {
    const p = { id: uid(), name, ids: [...ids], created: Date.now() };
    S.playlists.push(p); savePlaylists();
    if (ids.length) toast(`Added to “${name}”`); else go({ name: 'playlist', id: p.id });
  });
}
function addToPlaylist(pid, ids) {
  const p = S.playlists.find(x => x.id === pid); if (!p) return;
  p.ids.push(...ids); savePlaylists();
  toast(`Added ${ids.length === 1 ? '1 track' : ids.length + ' tracks'} to “${p.name}”`);
  if (S.view.name === 'playlist' && S.view.id === pid) render();
}
function renderPlaylists() {
  const el = $('#plList'); el.innerHTML = '';
  if (!S.playlists.length) { el.append(h('div', { class: 'pl-empty' }, 'No playlists yet')); return; }
  for (const p of S.playlists) {
    const first = p.ids.map(id => S.byId.get(id)).find(t => t?.art);
    const b = h('button', { class: 'pl-item' + (S.view.name === 'playlist' && S.view.id === p.id ? ' on' : ''), title: p.name },
      `<span class="pl-ic">${first ? `<img src="${artUrl(first.art)}">` : I.note}</span><span>${esc(p.name)}</span>`);
    b.onclick = () => go({ name: 'playlist', id: p.id });
    b.oncontextmenu = e => { e.preventDefault(); showMenu(e.clientX, e.clientY, [
      { label: 'Play', fn: () => playList(p.ids, 0, false) },
      { label: 'Rename…', fn: () => renamePlaylist(p) },
      { label: 'Delete', fn: () => deletePlaylist(p) }]); };
    b.ondragover = e => { if (e.dataTransfer.types.includes('application/x-pulse')) { e.preventDefault(); b.classList.add('drop'); } };
    b.ondragleave = () => b.classList.remove('drop');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('drop'); const d = JSON.parse(e.dataTransfer.getData('application/x-pulse') || '{}'); if (d.ids) addToPlaylist(p.id, d.ids); };
    el.append(b);
  }
}
function renamePlaylist(p) { promptModal('Rename playlist', 'Name', p.name, name => { p.name = name; savePlaylists(); if (S.view.id === p.id) render(); }); }
function deletePlaylist(p) {
  confirmModal(`Delete “${p.name}”?`, 'This removes the playlist only — your music files are not touched.', 'Delete', () => {
    S.playlists = S.playlists.filter(x => x !== p); savePlaylists();
    if (S.view.name === 'playlist' && S.view.id === p.id) go({ name: 'albums' });
  });
}

/* ================================ modals ================================ */
function modal(content, cls = '') {
  const bd = h('div', { class: 'backdrop' });
  const m = h('div', { class: 'modal ' + cls }); m.append(...[].concat(content));
  bd.append(m);
  const close = () => { bd.remove(); removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  bd.addEventListener('mousedown', e => { if (e.target === bd) close(); });
  $('#modalRoot').append(bd);
  return { el: m, close };
}
function promptModal(title, label, value, onOk) {
  const input = h('input', { type: 'text', value, placeholder: label });
  const ok = h('button', { class: 'btn primary' }, 'Save'), cancel = h('button', { class: 'btn' }, 'Cancel');
  const md = modal([h('h3', {}, esc(title)), input, (() => { const r = h('div', { class: 'row' }); r.append(cancel, ok); return r; })()]);
  const submit = () => { const v = input.value.trim(); if (!v) return input.focus(); md.close(); onOk(v); };
  ok.onclick = submit; cancel.onclick = md.close;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  setTimeout(() => { input.focus(); input.select(); }, 20);
}
function confirmModal(title, text, okLabel, onOk) {
  const ok = h('button', { class: 'btn primary' }, esc(okLabel)), cancel = h('button', { class: 'btn' }, 'Cancel');
  const row = h('div', { class: 'row' }); row.append(cancel, ok);
  const md = modal([h('h3', {}, esc(title)), h('p', { class: 'note' }, esc(text)), row]);
  ok.onclick = () => { md.close(); onOk(); }; cancel.onclick = md.close;
}
function foldersModal() {
  const list = h('div');
  const draw = () => {
    list.innerHTML = '';
    if (!S.folders.length) list.append(h('p', { class: 'note', style: 'margin-bottom:10px' }, 'No folders yet. Add the folder where you keep your music — subfolders are included.'));
    for (const f of S.folders) {
      const row = h('div', { class: 'folder' }, `<span title="${esc(f)}">‎${esc(f)}‎</span>`);
      const rm = h('button', { class: 'mini', title: 'Remove from library' }, I.x);
      rm.onclick = async () => { await api.removeFolder(f); await refreshLibrary(); draw(); };
      row.append(rm); list.append(row);
    }
  };
  draw();
  const add = h('button', { class: 'btn primary' }, 'Add folder…'), rescan = h('button', { class: 'btn' }, 'Rescan'), done = h('button', { class: 'btn' }, 'Done');
  const row = h('div', { class: 'row' }); row.append(rescan, add, done);
  const md = modal([h('h3', {}, 'Library folders'), list,
    h('p', { class: 'note', style: 'margin-top:12px' }, 'Pulse reads FLAC, MP3, AAC/M4A, WAV, OGG and Opus. Files are never modified. Tags and cover art are read from the files (or a cover.jpg / folder.jpg next to them).'), row]);
  add.onclick = async () => { if (await api.addFolder()) { await refreshLibrary(); draw(); } };
  rescan.onclick = () => { api.rescan(); md.close(); };
  done.onclick = md.close;
}

/* ---------------- sound panel: EQ + ReplayGain ---------------- */
const EQ_PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Vocal': [-2, -2, -1, 1, 3, 3, 2, 1, 0, -1],
  'Rock': [4, 3, 2, 0, -1, -1, 1, 2, 3, 4],
  'Electronic': [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
  'Classical': [3, 2, 1, 0, 0, 0, -1, -1, 1, 2],
  'Jazz': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  'Loudness': [5, 3, 0, 0, -1, 0, -1, 0, 3, 5],
  'Headphones': [3, 2, 0, -1, -1, 0, 1, 2, 3, 2]
};
let eqState = store.get('eq', { enabled: false, preamp: 0, gains: EQ_FREQS.map(() => 0), preset: 'Flat' });
let rgState = store.get('rg', { mode: 'album', preamp: 0, noTagDb: -6, preventClip: true });
engine.setEq(eqState); engine.setReplayGain(rgState);

function soundModal() {
  const wrap = h('div');
  const fLabel = f => f >= 1000 ? (f / 1000) + 'k' : String(f);
  const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(Math.abs(v) % 1 ? 1 : 0);
  const draw = () => {
    wrap.innerHTML = '';
    // --- EQ
    const sw = h('button', { class: 'switch' + (eqState.enabled ? ' on' : ''), title: 'Enable equalizer' });
    sw.onclick = () => { eqState.enabled = !eqState.enabled; applyEq(); draw(); };
    const sel = h('select');
    for (const n of [...Object.keys(EQ_PRESETS), 'Custom']) sel.append(h('option', { value: n, selected: n === eqState.preset }, n));
    sel.onchange = () => { if (EQ_PRESETS[sel.value]) { eqState.gains = [...EQ_PRESETS[sel.value]]; eqState.preset = sel.value; eqState.enabled = true; applyEq(); draw(); } };
    const head = h('div', { class: 'sec-h' }); const l = h('div', { style: 'display:flex;align-items:center;gap:12px' }); l.append(sw, h('b', {}, 'Equalizer'));
    head.append(l, sel);
    const eq = h('div', { class: 'eq' + (eqState.enabled ? '' : ' off') });
    const mk = (label, val, onInput, cls = '') => {
      const b = h('div', { class: 'band ' + cls });
      const v = h('div', { class: 'val' }, sign(val));
      const r = h('input', { type: 'range', min: -12, max: 12, step: 0.5, value: val });
      r.oninput = () => { onInput(+r.value); v.textContent = sign(+r.value); };
      r.ondblclick = () => { r.value = 0; r.oninput(); };
      b.append(v, r, h('div', {}, label)); return b;
    };
    eq.append(mk('Pre', eqState.preamp, x => { eqState.preamp = x; applyEq(); }, 'pre'));
    EQ_FREQS.forEach((f, i) => eq.append(mk(fLabel(f), eqState.gains[i], x => { eqState.gains[i] = x; eqState.preset = 'Custom'; sel.value = 'Custom'; if (!eqState.enabled) { eqState.enabled = true; sw.classList.add('on'); eq.classList.remove('off'); } applyEq(); })));
    // --- ReplayGain
    const seg = h('div', { class: 'seg' });
    for (const [k, lab] of [['off', 'Off'], ['track', 'Track'], ['album', 'Album']]) {
      const b = h('button', { class: rgState.mode === k ? 'on' : '' }, lab);
      b.onclick = () => { rgState.mode = k; applyRg(); draw(); }; seg.append(b);
    }
    const rgHead = h('div', { class: 'sec-h' }); rgHead.append(h('b', {}, 'ReplayGain'), seg);
    const slider = (label, key, min, max) => {
      const row = h('div', { class: 'kv' });
      const v = h('div', { class: 'v' }, sign(rgState[key]) + ' dB');
      const r = h('input', { type: 'range', min, max, step: 0.5, value: rgState[key] }); paint(r);
      r.oninput = () => { rgState[key] = +r.value; v.textContent = sign(+r.value) + ' dB'; paint(r); applyRg(); };
      row.append(h('div', {}, label), r, v); return row;
    };
    const clip = h('label', { class: 'check' }, `<input type="checkbox" ${rgState.preventClip ? 'checked' : ''}> Prevent clipping using peak tags`);
    clip.querySelector('input').onchange = e => { rgState.preventClip = e.target.checked; applyRg(); };
    const t = engine.track, info = t && engine.rgInfo(t);
    const now = h('p', { class: 'note', style: 'margin-top:10px' }, t ? (info ? `Now playing: ${info.tagged ? 'tagged' : 'untagged'}, applying ${sign(+info.db.toFixed(1))} dB.` : 'ReplayGain is off.') : '');
    // --- Output
    const out = h('p', { class: 'note' }, `Engine: Web Audio at ${srK(engine.ctx.sampleRate)} kHz, 32-bit float. Sources at other rates (e.g. 96 kHz) are converted with high-quality resampling; the source format is always shown on the player. Tracks are fully decoded in advance so album transitions are gapless.`);
    wrap.append(head, eq, h('hr', { class: 'sep' }), rgHead,
      h('p', { class: 'note', style: 'margin-bottom:8px' }, 'Evens out loudness between tracks using the ReplayGain tags in your files. Album mode keeps the dynamics within an album intact.'),
      slider('Preamp', 'preamp', -15, 15), slider('Untagged files', 'noTagDb', -15, 0), clip, now,
      h('hr', { class: 'sep' }), (() => { const x = h('div', { class: 'sec-h' }); x.append(h('b', {}, 'Output')); return x; })(), out);
  };
  draw();
  const close = h('button', { class: 'mini', title: 'Close' }, I.x);
  const title = h('h3', {}, 'Sound'); title.append(close);
  const md = modal([title, wrap], 'sound');
  close.onclick = md.close;
}
function applyEq() { engine.setEq(eqState); store.set('eq', eqState); $('#soundBtn').classList.toggle('on', eqState.enabled); }
function applyRg() { engine.setReplayGain(rgState); store.set('rg', rgState); }

/* ================================ views ================================ */
function go(view) {
  if (JSON.stringify(view) === JSON.stringify(S.view) && !S.query) return;
  S.history.push(S.view);
  S.view = view; store.set('view', view);
  if (S.query) { S.query = ''; $('#search').value = ''; }
  render(); $('#main').scrollTop = 0;
}
function currentListIds() {
  if (S.view.name === 'album') return S.albumByKey.get(S.view.id)?.ids || [];
  if (S.view.name === 'playlist') return S.playlists.find(p => p.id === S.view.id)?.ids || [];
  return sortedSongs();
}
function sortedSongs() {
  const by = S.songSort, arr = [...S.tracks];
  const strip = s => (s || '').replace(/^the /i, '');
  const albumOrder = (a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 999) - (b.track || 999) || cmp(a.title, b.title);
  arr.sort(by === 'title' ? (a, b) => cmp(a.title, b.title)
    : by === 'album' ? (a, b) => cmp(a.album, b.album) || albumOrder(a, b)
    : by === 'dur' ? (a, b) => (b.duration || 0) - (a.duration || 0)
    : by === 'fmt' ? (a, b) => (b.sampleRate || 0) * (b.bits || 0) - (a.sampleRate || 0) * (a.bits || 0) || cmp(a.title, b.title)
    : (a, b) => cmp(strip(a.albumArtist), strip(b.albumArtist)) || (a.year || 0) - (b.year || 0) || cmp(a.album, b.album) || albumOrder(a, b));
  return arr.map(t => t.id);
}

function render() {
  S.virtualDraw = null;
  const main = $('#main');
  $$('#nav button').forEach(b => b.classList.toggle('on', !S.query && b.dataset.view === S.view.name));
  renderPlaylists();
  let v;
  if (!S.tracks.length && !['playlist', 'queue'].includes(S.view.name)) v = viewEmpty();
  else if (S.query) v = viewSearch(S.query);
  else switch (S.view.name) {
    case 'album': v = viewAlbum(S.albumByKey.get(S.view.id)); break;
    case 'artist': v = viewArtist(S.view.id); break;
    case 'artists': v = viewArtists(); break;
    case 'songs': v = viewSongs(); break;
    case 'queue': v = viewQueue(); break;
    case 'playlist': v = viewPlaylist(S.playlists.find(p => p.id === S.view.id)); break;
    default: v = viewAlbums();
  }
  main.replaceChildren(v);
  markPlaying();
}
$('#main').addEventListener('scroll', () => S.virtualDraw?.(), { passive: true });
addEventListener('resize', () => S.virtualDraw?.(true));

function viewHead(title, sub, right) {
  const hd = h('div', { class: 'view-head' });
  const l = h('div'); l.append(h('h1', {}, esc(title))); if (sub) l.append(h('div', { class: 'sub' }, esc(sub)));
  hd.append(l); if (right) hd.append(right);
  return hd;
}
function sortSel(options, cur, onPick) {
  const s = h('div', { class: 'sortsel' });
  for (const [k, lab] of options) { const b = h('button', { class: k === cur ? 'on' : '' }, lab); b.onclick = () => onPick(k); s.append(b); }
  return s;
}
function albumCard(a, sub) {
  const c = h('div', { class: 'card', title: `${a.title} — ${a.artist}` });
  c.innerHTML = `<div class="cover">${coverHTML(a.art, a.title, `<button class="hover-play" title="Play">${I.play}</button>`)}</div>
    <div class="ct">${esc(a.title)}</div><div class="cs">${a.hires ? `<span class="hr">${a.bits}/${srK(a.sr)}</span>` : ''}<span>${esc(sub ?? a.artist)}</span></div>`;
  c.onclick = e => { if (e.target.closest('.hover-play')) playList(a.ids, 0, false); else go({ name: 'album', id: a.key }); };
  c.oncontextmenu = e => { e.preventDefault(); albumMenu(e.clientX, e.clientY, a); };
  c.draggable = true;
  c.ondragstart = e => e.dataTransfer.setData('application/x-pulse', JSON.stringify({ ids: a.ids }));
  return c;
}
function viewEmpty() {
  const v = h('div', { class: 'view' });
  const e = h('div', { class: 'empty' }, `<div class="logo" style="width:56px;height:56px;border-radius:16px"></div><h1>Welcome to Pulse</h1>
    <p>Add the folder where you keep your music. Pulse reads your FLAC tags and cover art and builds your library — your files are never changed.</p>`);
  const a = h('div', { class: 'actions' });
  const add = h('button', { class: 'btn primary' }, 'Add music folder'), open = h('button', { class: 'btn' }, 'Open files');
  add.onclick = async () => { if (await api.addFolder()) refreshLibrary(); };
  open.onclick = openFiles;
  a.append(add, open);
  e.append(a, h('p', { class: 'note' }, 'Or drag files and folders anywhere onto this window.'));
  v.append(e); return v;
}
function viewAlbums() {
  const v = h('div', { class: 'view' });
  v.append(viewHead('Albums', `${S.albums.length.toLocaleString()} albums`, sortSel([['artist', 'Artist'], ['title', 'Title'], ['year', 'Newest']], S.albumSort,
    k => { S.albumSort = k; store.set('albumSort', k); sortAlbums(); render(); })));
  const g = h('div', { class: 'grid' });
  for (const a of S.albums) g.append(albumCard(a, a.year ? `${a.artist} · ${a.year}` : a.artist));
  v.append(g); return v;
}
function viewArtists() {
  const v = h('div', { class: 'view' });
  v.append(viewHead('Artists', `${S.artists.length.toLocaleString()} artists`));
  const g = h('div', { class: 'grid' });
  for (const ar of S.artists) {
    const c = h('div', { class: 'card round' }, `<div class="cover">${coverHTML(ar.art, ar.name)}</div><div class="ct">${esc(ar.name)}</div><div class="cs">${ar.albums.length} album${ar.albums.length > 1 ? 's' : ''}</div>`);
    c.onclick = () => go({ name: 'artist', id: ar.name });
    g.append(c);
  }
  v.append(g); return v;
}
function detailHeader({ kicker, title, by, meta, cover, actions }) {
  const d = h('div', { class: 'detail' });
  d.append(cover);
  const info = h('div', { style: 'min-width:0' });
  info.append(h('div', { class: 'kicker' }, esc(kicker)), h('h1', {}, esc(title)));
  if (by) info.append(by);
  if (meta) info.append(h('div', { class: 'meta' }, meta));
  const act = h('div', { class: 'actions' }); act.append(...actions); info.append(act);
  d.append(info); return d;
}
function actBtn(label, icon, fn, cls = '') { const b = h('button', { class: 'btn ' + cls, title: label }, icon + (cls.includes('round') ? '' : esc(label))); b.onclick = fn; return b; }
function viewAlbum(a) {
  if (!a) return viewEmptyMsg('Album not found');
  const v = h('div', { class: 'view' });
  const by = h('div', { class: 'by' }); const link = h('a', {}, esc(a.artist)); link.onclick = () => go({ name: 'artist', id: a.artist }); by.append(link);
  const first = S.byId.get(a.ids[0]);
  const fmt = a.hires ? `<span class="hr">${first.codec} ${a.bits}/${srK(a.sr)}</span>` : `<span class="badge">${esc([...a.codecs].join(' / '))}${a.bits ? ` ${a.bits}/${srK(a.sr)}` : ''}</span>`;
  const more = actBtn('More', I.more, e => albumMenu(e.clientX, e.clientY, a), 'round');
  v.append(detailHeader({
    kicker: 'Album', title: a.title, by,
    meta: `${a.year ? a.year + ' · ' : ''}${a.ids.length} track${a.ids.length > 1 ? 's' : ''} · ${fmtLong(a.duration)} · ${fmt}`,
    cover: h('div', { class: 'cover' }, coverHTML(a.art, a.title)),
    actions: [actBtn('Play', I.play, () => playList(a.ids, 0, false), 'primary'), actBtn('Shuffle', I.shuffle, () => playList(a.ids, 0, true)),
      actBtn('Add to queue', I.queueAdd, () => addToQueue(a.ids), 'round'), more]
  }));
  v.append(trackTable(a.ids, { cols: ['num', 'title', 'fmt', 'dur'], trackNums: true, discs: a.multiDisc, artistUnder: a.ids.some(id => S.byId.get(id).artist !== a.artist) }));
  return v;
}
function viewArtist(name) {
  const albums = artistAlbums(name);
  if (!albums.length) return viewEmptyMsg('Artist not found');
  const v = h('div', { class: 'view' });
  const all = albums.flatMap(a => a.ids);
  const ar = S.artistByName.get(name.toLowerCase());
  v.append(detailHeader({
    kicker: 'Artist', title: ar.name, meta: `${albums.length} album${albums.length > 1 ? 's' : ''} · ${all.length} tracks`,
    cover: h('div', { class: 'cover', style: 'border-radius:50%' }, coverHTML(ar.art, ar.name)),
    actions: [actBtn('Play', I.play, () => playList(all, 0, false), 'primary'), actBtn('Shuffle', I.shuffle, () => playList(all, 0, true))]
  }));
  v.append(h('h2', { class: 'sec' }, 'Albums'));
  const g = h('div', { class: 'grid' });
  albums.forEach(a => g.append(albumCard(a, a.year || ''))); v.append(g);
  // tracks credited to this artist on other artists' albums
  const lower = name.toLowerCase();
  const feats = S.tracks.filter(t => t.artist.toLowerCase().includes(lower) && t.albumArtist.toLowerCase() !== lower).map(t => t.id);
  if (feats.length) { v.append(h('h2', { class: 'sec' }, 'Appears on')); v.append(trackTable(feats, { cols: ['num', 'title', 'album', 'dur'] })); }
  return v;
}
function viewSongs() {
  const v = h('div', { class: 'view' });
  const ids = sortedSongs();
  const total = S.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  v.append(viewHead('Songs', `${ids.length.toLocaleString()} songs · ${fmtLong(total)}`, sortSel([['artist', 'Artist'], ['album', 'Album'], ['title', 'Title'], ['fmt', 'Quality']], S.songSort,
    k => { S.songSort = k; store.set('songSort', k); render(); })));
  v.append(trackTable(ids, { thumbs: true, onSort: k => { S.songSort = k === 'dur' ? 'dur' : k; store.set('songSort', S.songSort); render(); } }));
  return v;
}
function viewQueue() {
  const v = h('div', { class: 'view' });
  const ids = Q.order.map(i => Q.ids[i]);
  const remaining = Q.order.slice(Q.pos + 1).reduce((s, i) => s + (S.byId.get(Q.ids[i])?.duration || 0), 0);
  const clear = h('button', { class: 'btn' }, 'Clear queue');
  clear.onclick = () => { engine.stop(); Object.assign(Q, { ids: [], order: [], pos: -1, restoreAt: 0 }); saveQueue(); updateNowPlaying(); render(); };
  v.append(viewHead('Now Playing', ids.length ? `${ids.length} tracks · ${fmtLong(remaining)} remaining${Q.shuffle ? ' · shuffled' : ''}` : 'The queue is empty', ids.length ? clear : null));
  if (!ids.length) { v.append(h('p', { class: 'note' }, 'Play an album, playlist or song, or right-click anything and choose “Add to queue”.')); return v; }
  v.append(trackTable(ids, {
    cols: ['num', 'title', 'album', 'fmt', 'dur', 'rm'], thumbs: true, artistUnder: true, queue: true, dragSrc: 'queue',
    onPlay: i => { Q.pos = i; playCurrent(0, true); render(); },
    onRemove: i => removeFromQueue(i), removeLabel: 'Remove from queue',
    onMove: (from, to) => moveInQueue(from, to),
    onInsert: (newIds, to) => { const base = Q.ids.length; Q.ids.push(...newIds); Q.order.splice(to, 0, ...newIds.map((_, k) => base + k)); if (to <= Q.pos) Q.pos += newIds.length; afterQueueChange(); }
  }));
  requestAnimationFrame(() => { const r = $(`.tr[data-qpos="${Q.pos}"]`); if (r) r.scrollIntoView({ block: 'center' }); });
  return v;
}
function viewPlaylist(p) {
  if (!p) return viewEmptyMsg('Playlist not found');
  const v = h('div', { class: 'view' });
  const tracks = p.ids.map(id => S.byId.get(id)).filter(Boolean);
  const arts = [...new Set(tracks.map(t => t.art).filter(Boolean))].slice(0, 4);
  const cover = arts.length >= 4 ? h('div', { class: 'cover mosaic' }, arts.map(a => `<img src="${artUrl(a)}">`).join(''))
    : h('div', { class: 'cover' }, arts.length ? `<img src="${artUrl(arts[0])}">` : `<div class="ph" style="background:linear-gradient(135deg,#3a2a5a,#16222e)">${I.note.replace('<svg', '<svg style="width:64px;height:64px"')}</div>`);
  v.append(detailHeader({
    kicker: 'Playlist', title: p.name, meta: `${p.ids.length} track${p.ids.length === 1 ? '' : 's'} · ${fmtLong(tracks.reduce((s, t) => s + t.duration, 0))}`, cover,
    actions: [actBtn('Play', I.play, () => playList(p.ids, 0, false), 'primary'), actBtn('Shuffle', I.shuffle, () => playList(p.ids, 0, true)),
      actBtn('Rename', I.edit, () => renamePlaylist(p), 'round'), actBtn('Delete playlist', I.trash, () => deletePlaylist(p), 'round')]
  }));
  if (!p.ids.length) { v.append(h('p', { class: 'note' }, 'Drag songs or albums onto this playlist in the sidebar, or right-click any song → Add to playlist.')); return v; }
  v.append(trackTable(p.ids, {
    cols: ['num', 'title', 'album', 'fmt', 'dur', 'rm'], thumbs: true, artistUnder: true, dragSrc: 'pl:' + p.id,
    onRemove: i => { p.ids.splice(i, 1); savePlaylists(); render(); }, removeLabel: 'Remove from playlist',
    onMove: (from, to) => { const [x] = p.ids.splice(from, 1); if (to > from) to--; p.ids.splice(to, 0, x); savePlaylists(); render(); },
    onInsert: (ids, to) => { p.ids.splice(to, 0, ...ids); savePlaylists(); render(); }
  }));
  return v;
}
function viewSearch(q) {
  const v = h('div', { class: 'view' });
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = s => terms.every(t => s.includes(t));
  const artists = S.artists.filter(a => hit(a.name.toLowerCase())).slice(0, 24);
  const albums = S.albums.filter(a => hit((a.title + ' ' + a.artist).toLowerCase())).slice(0, 24);
  const songs = S.tracks.filter(t => hit((t.title + ' ' + t.artist + ' ' + t.album).toLowerCase())).slice(0, 500).map(t => t.id);
  v.append(viewHead(`Results for “${q}”`, `${artists.length} artists · ${albums.length} albums · ${songs.length}${songs.length === 500 ? '+' : ''} songs`));
  if (artists.length) {
    v.append(h('h2', { class: 'sec' }, 'Artists'));
    const c = h('div', { class: 'chips' });
    artists.forEach(a => { const x = h('span', { class: 'chip' }, esc(a.name)); x.onclick = () => go({ name: 'artist', id: a.name }); c.append(x); });
    v.append(c);
  }
  if (albums.length) { v.append(h('h2', { class: 'sec' }, 'Albums')); const g = h('div', { class: 'grid' }); albums.forEach(a => g.append(albumCard(a))); v.append(g); }
  if (songs.length) { v.append(h('h2', { class: 'sec' }, 'Songs')); v.append(trackTable(songs, { thumbs: true })); }
  if (!artists.length && !albums.length && !songs.length) v.append(h('p', { class: 'note' }, 'Nothing matched.'));
  return v;
}
function viewEmptyMsg(msg) { const v = h('div', { class: 'view' }); v.append(h('div', { class: 'empty' }, `<p>${esc(msg)}</p>`)); return v; }

/* ================================ visualizer ================================ */
let viz = null, vizIdleT;
function openViz() {
  try { if (!viz) { viz = new Visualizer($('#vizCanvas'), engine.analyser); viz.isPlaying = () => engine.playing; } }
  catch (e) { toast('Visualizer needs WebGL, which is unavailable'); return; }
  $('#viz').classList.remove('hidden'); viz.start(); vizWake();
}
function closeViz() { $('#viz').classList.add('hidden'); viz?.stop(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
const vizOpen = () => !$('#viz').classList.contains('hidden');
function vizWake() { $('#viz').classList.remove('idle'); clearTimeout(vizIdleT); vizIdleT = setTimeout(() => $('#viz').classList.add('idle'), 2500); }
$('#viz').addEventListener('mousemove', vizWake);
$('#vizPreset').onclick = () => { $('#vizPreset').textContent = viz.next(); };
$('#vizClose').onclick = closeViz;
const toggleFull = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); };
$('#vizFull').onclick = toggleFull;
$('#viz').addEventListener('dblclick', e => { if (!e.target.closest('button')) toggleFull(); });

/* ================================ misc ================================ */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

async function refreshLibrary() {
  const keepView = S.view;
  await loadLibrary();
  S.view = keepView;
  render(); updateNowPlaying();
}
async function openFiles() {
  const ids = await api.openFiles();
  if (ids?.length) { await refreshLibrary(); playList(ids, 0, false); }
}

// scan progress from main process
api.onScanProgress(async d => {
  const el = $('#scan');
  if (!d) { el.classList.add('hidden'); await refreshLibrary(); return; }
  el.classList.remove('hidden');
  $('.scan-label', el).textContent = d.total ? `Scanning ${d.label || ''} — ${d.done.toLocaleString()} / ${d.total.toLocaleString()}` : (d.label || 'Scanning…');
  $('.scan-bar i', el).style.width = d.total ? (d.done / d.total * 100) + '%' : '8%';
});
api.onOpenTracks(async ids => { await refreshLibrary(); playList(ids, 0, false); });

// drag & drop files from the OS
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging-files'); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging-files'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging-files');
  const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  toast('Adding…');
  const ids = await api.addPaths(paths);
  await refreshLibrary();
  if (ids.length) playList(ids, 0, false); else toast('No playable audio found');
});

// controls
$('#playBtn').onclick = togglePlay;
$('#nextBtn').onclick = next;
$('#prevBtn').onclick = prev;
$('#shuffleBtn').onclick = toggleShuffle;
$('#repeatBtn').onclick = cycleRepeat;
$('#vizBtn').onclick = openViz;
$('#queueBtn').onclick = () => go({ name: 'queue' });
$('#soundBtn').onclick = soundModal;
$('#foldersBtn').onclick = foldersModal;
$('#newPl').onclick = () => newPlaylist();
$('#npArt').onclick = () => { const t = engine.track || curTrack(); if (t) go({ name: 'album', id: t.albumKey }); };
$('#npArtist').onclick = () => { const t = engine.track || curTrack(); if (t) go({ name: 'artist', id: t.albumArtist }); };
$$('#nav button').forEach(b => b.onclick = () => go({ name: b.dataset.view }));

const seek = $('#seek');
seek.addEventListener('input', () => {
  seeking = true; paint(seek);
  const d = engine.track ? engine.duration : (curTrack()?.duration || 0);
  $('#tCur').textContent = fmtTime(seek.value / 1000 * d);
});
seek.addEventListener('change', () => {
  const d = engine.track ? engine.duration : (curTrack()?.duration || 0);
  const t = seek.value / 1000 * d;
  if (engine.track) engine.seek(t); else if (curTrack()) { Q.restoreAt = t; }
  seeking = false;
});

const vol = $('#vol');
let lastVol = store.get('vol', 0.9);
function setVol(v, remember = true) {
  vol.value = v; paint(vol); engine.setVolume(+v);
  $('#volIcon').innerHTML = +v === 0 ? I.volOff : +v < 0.5 ? I.volLow : I.volOn;
  if (remember && +v > 0) lastVol = +v;
  store.set('vol', +v);
}
vol.addEventListener('input', () => setVol(vol.value));
vol.addEventListener('wheel', e => { e.preventDefault(); setVol(Math.max(0, Math.min(1, +vol.value - Math.sign(e.deltaY) * 0.05))); }, { passive: false });
$('#muteBtn').onclick = () => setVol(+vol.value > 0 ? 0 : (lastVol || 0.8), false);

let searchT;
$('#search').addEventListener('input', e => {
  clearTimeout(searchT);
  searchT = setTimeout(() => { S.query = e.target.value.trim(); render(); $('#main').scrollTop = 0; }, 140);
});

addEventListener('keydown', e => {
  const typing = e.target.matches('input[type=text],input[type=search],textarea');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.key === 'Escape') {
    if (vizOpen()) return closeViz();
    if (typing && e.target.id === 'search') { e.target.value = ''; S.query = ''; e.target.blur(); render(); }
    return;
  }
  if (typing || $('#modalRoot').children.length) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (mod && e.key === 'ArrowRight') next();
  else if (mod && e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight' && engine.track) engine.seek(engine.position + 10);
  else if (e.key === 'ArrowLeft' && engine.track) engine.seek(engine.position - 10);
  else if (e.key === 'ArrowUp' && mod) { e.preventDefault(); setVol(Math.min(1, +vol.value + 0.05)); }
  else if (e.key === 'ArrowDown' && mod) { e.preventDefault(); setVol(Math.max(0, +vol.value - 0.05)); }
  else if (e.key.toLowerCase() === 'v' && !mod) vizOpen() ? closeViz() : openViz();
  else if (e.key.toLowerCase() === 'n' && vizOpen()) $('#vizPreset').click();
  else if (e.key.toLowerCase() === 'f' && vizOpen()) toggleFull();
  else if (e.key.toLowerCase() === 's' && !mod) toggleShuffle();
  else if (e.key.toLowerCase() === 'r' && !mod) cycleRepeat();
  else if (e.key === 'Backspace' && S.history.length) { S.view = S.history.pop(); render(); }
});
addEventListener('mouseup', e => { if (e.button === 3 && S.history.length) { S.view = S.history.pop(); render(); } });

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
  set('play', () => togglePlay()); set('pause', () => engine.pause());
  set('nexttrack', next); set('previoustrack', prev);
  set('seekto', d => engine.seek(d.seekTime));
}
addEventListener('beforeunload', () => store.set('queue', { ids: Q.ids, order: Q.order, pos: Q.pos, shuffle: Q.shuffle, repeat: Q.repeat, at: engine.track ? engine.position : Q.restoreAt }));

/* ================================ boot ================================ */
(async () => {
  setVol(lastVol, false);
  applyEq();
  updateShuffleRepeat();
  await loadLibrary();
  await loadPlaylists();
  if (S.view.name === 'album' && !S.albumByKey.has(S.view.id)) S.view = { name: 'albums' };
  restoreQueue();
  render();
  api.ready();
})();

// debugging handle (DevTools console)
window.__pulse = { S, Q, engine, playList, next, go };
