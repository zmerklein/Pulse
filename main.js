'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');
const mm = require('music-metadata');

protocol.registerSchemesAsPrivileged([{
  scheme: 'pulse',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.json': 'application/json'
};

let win = null;
let DATA, ART_DIR, LIB_FILE, PL_FILE;
let lib = { folders: [], tracks: {} };   // tracks keyed by id
let playlists = [];
let scanning = null;
const pendingOpen = [];                  // paths passed via argv / open-file before the window was ready

/* ------------------------------ persistence ------------------------------ */
async function loadJSON(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
let saveTimer = null;
function saveLib() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeAtomic(LIB_FILE, JSON.stringify(lib)), 300);
}
async function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/* ------------------------------ scanning ------------------------------ */
const idFor = p => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 16);
const isAudio = p => AUDIO_EXT.has(path.extname(p).toLowerCase());
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && isAudio(e.name)) out.push(full);
  }
  return out;
}

const albumArtCache = new Map();   // albumKey -> art file name
const dirCoverCache = new Map();   // dir -> art file name | null

async function saveArt(data, format) {
  const ext = /png/i.test(format || '') ? '.png' : /webp/i.test(format || '') ? '.webp' : '.jpg';
  const name = crypto.createHash('sha1').update(data).digest('hex').slice(0, 20) + ext;
  const file = path.join(ART_DIR, name);
  try { await fsp.access(file); } catch { await fsp.writeFile(file, data); }
  return name;
}
async function dirCover(dir) {
  if (dirCoverCache.has(dir)) return dirCoverCache.get(dir);
  let found = null;
  try {
    const files = await fsp.readdir(dir);
    const pick = files.find(f => {
      const b = path.parse(f); return /\.(jpe?g|png|webp)$/i.test(b.ext) && COVER_NAMES.includes(b.name.toLowerCase());
    });
    if (pick) found = await saveArt(await fsp.readFile(path.join(dir, pick)), path.extname(pick));
  } catch { /* ignore */ }
  dirCoverCache.set(dir, found);
  return found;
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
async function parseTrack(file, st) {
  const meta = await mm.parseFile(file, { duration: true, skipCovers: false });
  const c = meta.common, f = meta.format;
  const base = path.basename(file, path.extname(file));
  const artist = c.artist || (c.artists && c.artists.join(', ')) || 'Unknown Artist';
  const albumArtist = c.albumartist || artist;
  const album = c.album || path.basename(path.dirname(file)) || 'Unknown Album';
  const albumKey = (albumArtist + '\u0001' + album).toLowerCase();

  let art = albumArtCache.get(albumKey) || null;
  if (!art && c.picture && c.picture.length) {
    const pic = c.picture.find(p => /front/i.test(p.type || '')) || c.picture[0];
    art = await saveArt(pic.data, pic.format);
  }
  if (!art) art = await dirCover(path.dirname(file));
  if (art) albumArtCache.set(albumKey, art);

  return {
    id: idFor(file), path: file, size: st.size, mtime: st.mtimeMs,
    title: c.title || base, artist, albumArtist, album, albumKey,
    track: (c.track && c.track.no) || null, disc: (c.disk && c.disk.no) || 1,
    year: c.year || null, genre: (c.genre && c.genre[0]) || null,
    duration: num(f.duration) || 0,
    codec: (f.codec || f.container || path.extname(file).slice(1)).toUpperCase().replace('MPEG 1 LAYER 3', 'MP3'),
    lossless: !!f.lossless, sampleRate: num(f.sampleRate), bits: num(f.bitsPerSample),
    channels: num(f.numberOfChannels) || 2, bitrate: num(f.bitrate),
    rgTrack: c.replaygain_track_gain ? num(c.replaygain_track_gain.dB) : null,
    rgTrackPeak: c.replaygain_track_peak ? num(c.replaygain_track_peak.ratio) : null,
    rgAlbum: c.replaygain_album_gain ? num(c.replaygain_album_gain.dB) : null,
    rgAlbumPeak: c.replaygain_album_peak ? num(c.replaygain_album_peak.ratio) : null,
    art
  };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// Parse a list of files, reusing cached entries whose size + mtime are unchanged.
async function ingest(files, label) {
  let done = 0; const total = files.length; let lastSend = 0;
  for (const t of Object.values(lib.tracks)) if (t.art) albumArtCache.set(t.albumKey, t.art);
  await pool(files, 6, async file => {
    try {
      const st = await fsp.stat(file);
      const id = idFor(file);
      const old = lib.tracks[id];
      if (!old || old.size !== st.size || Math.abs(old.mtime - st.mtimeMs) > 1) {
        const t = await parseTrack(file, st);
        if (old && old.adhoc) t.adhoc = true;
        lib.tracks[id] = t;
      }
    } catch (e) { console.warn('skip', file, e.message); }
    done++;
    const now = Date.now();
    if (now - lastSend > 120 || done === total) { lastSend = now; send('scan-progress', { done, total, label }); }
  });
}

async function scanAll() {
  if (scanning) return scanning;
  scanning = (async () => {
    send('scan-progress', { done: 0, total: 0, label: 'Finding music…' });
    const seen = new Set();
    for (const folder of lib.folders) {
      const files = await walk(folder, []);
      files.forEach(f => seen.add(idFor(f)));
      await ingest(files, path.basename(folder));
    }
    // drop tracks that vanished
    for (const [id, t] of Object.entries(lib.tracks)) {
      if (t.adhoc) { try { await fsp.access(t.path); } catch { delete lib.tracks[id]; } }
      else if (!seen.has(id)) delete lib.tracks[id];
    }
    saveLib();
    send('scan-progress', null);
  })().finally(() => { scanning = null; });
  return scanning;
}

// Files/folders dropped or opened: folders become library folders, files become ad-hoc tracks.
async function addPaths(paths) {
  const files = [], newFolders = [];
  for (const p of paths) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) { if (!lib.folders.some(f => path.resolve(f) === path.resolve(p))) newFolders.push(p); }
      else if (isAudio(p)) files.push(p);
    } catch { /* ignore */ }
  }
  const ids = [];
  if (files.length) {
    await ingest(files, 'Adding files');
    for (const f of files) {
      const t = lib.tracks[idFor(f)];
      if (t) { if (!lib.folders.some(d => isInside(f, d))) t.adhoc = true; ids.push(t.id); }
    }
  }
  if (newFolders.length) {
    lib.folders.push(...newFolders);
    for (const d of newFolders) {
      const fl = await walk(d, []);
      await ingest(fl, path.basename(d));
      fl.sort().forEach(f => { const t = lib.tracks[idFor(f)]; if (t) { delete t.adhoc; ids.push(t.id); } });
    }
  }
  saveLib();
  send('scan-progress', null);
  return ids;
}
const isInside = (file, dir) => { const r = path.relative(dir, file); return r && !r.startsWith('..') && !path.isAbsolute(r); };

/* ------------------------------ protocol ------------------------------ */
async function serveFile(file, req) {
  let st;
  try { st = await fsp.stat(file); } catch { return new Response('Not found', { status: 404 }); }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache'
  };
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1]) { start = +m[1]; end = m[2] ? +m[2] : st.size - 1; }
    else { start = Math.max(0, st.size - +m[2]); end = st.size - 1; }
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(st.size);
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}

function registerProtocol() {
  const SRC = path.join(__dirname, 'src');
  protocol.handle('pulse', req => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('Not found', { status: 404 });
    const p = decodeURIComponent(u.pathname);
    if (p === '/media') {
      const t = lib.tracks[u.searchParams.get('id')];
      return t ? serveFile(t.path, req) : new Response('Not found', { status: 404 });
    }
    if (p.startsWith('/art/')) return serveFile(path.join(ART_DIR, path.basename(p)), req);
    const file = path.join(SRC, path.normalize(p === '/' ? '/index.html' : p));
    if (!file.startsWith(SRC)) return new Response('Forbidden', { status: 403 });
    return serveFile(file, req);
  });
}

/* ------------------------------ window ------------------------------ */
function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 940, minHeight: 620,
    backgroundColor: '#0c0c12', show: false, title: 'Pulse',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: mac ? false : { color: '#0c0c12', symbolColor: '#d9d9e3', height: 38 },
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  });
  if (!mac) win.setMenuBarVisibility(false);
  win.loadURL('pulse://app/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function audioArgs(argv) {
  return argv.slice(1).filter(a => !a.startsWith('-') && isAudio(a) && fs.existsSync(a));
}
async function openExternalPaths(paths) {
  if (!paths.length) return;
  const ids = await addPaths(paths);
  if (ids.length) send('open-tracks', ids);
}

/* ------------------------------ IPC ------------------------------ */
ipcMain.handle('lib:get', () => ({ folders: lib.folders, tracks: Object.values(lib.tracks), platform: process.platform }));
ipcMain.handle('lib:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add music folder', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return false;
  await addPaths(r.filePaths);
  return true;
});
ipcMain.handle('lib:removeFolder', async (_e, folder) => {
  lib.folders = lib.folders.filter(f => f !== folder);
  for (const [id, t] of Object.entries(lib.tracks)) if (!t.adhoc && isInside(t.path, folder)) delete lib.tracks[id];
  saveLib();
  return true;
});
ipcMain.handle('lib:rescan', () => scanAll());
ipcMain.handle('lib:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open audio files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: [...AUDIO_EXT].map(e => e.slice(1)) }]
  });
  if (r.canceled) return [];
  return addPaths(r.filePaths);
});
ipcMain.handle('lib:addPaths', (_e, paths) => addPaths(paths.filter(p => typeof p === 'string')));
ipcMain.handle('pl:get', () => playlists);
ipcMain.handle('pl:save', async (_e, pls) => { playlists = pls; await writeAtomic(PL_FILE, JSON.stringify(pls, null, 1)); return true; });
ipcMain.handle('shell:reveal', (_e, id) => { const t = lib.tracks[id]; if (t) shell.showItemInFolder(t.path); });
ipcMain.handle('app:ready', () => { const p = pendingOpen.splice(0); openExternalPaths(p); return app.getVersion(); });

/* ------------------------------ lifecycle ------------------------------ */
if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openExternalPaths(audioArgs(argv));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); if (win) openExternalPaths([p]); else pendingOpen.push(p); });
  pendingOpen.push(...audioArgs(process.argv));

  app.whenReady().then(async () => {
    DATA = app.getPath('userData');
    ART_DIR = path.join(DATA, 'art');
    LIB_FILE = path.join(DATA, 'library.json');
    PL_FILE = path.join(DATA, 'playlists.json');
    await fsp.mkdir(ART_DIR, { recursive: true });
    lib = await loadJSON(LIB_FILE, { folders: [], tracks: {} });
    playlists = await loadJSON(PL_FILE, []);
    registerProtocol();
    createWindow();
    if (lib.folders.length) setTimeout(() => scanAll(), 1500);  // pick up changes in the background
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
