'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  ready: () => ipcRenderer.invoke('app:ready'),
  getLibrary: () => ipcRenderer.invoke('lib:get'),
  addFolder: () => ipcRenderer.invoke('lib:addFolder'),
  removeFolder: f => ipcRenderer.invoke('lib:removeFolder', f),
  rescan: () => ipcRenderer.invoke('lib:rescan'),
  openFiles: () => ipcRenderer.invoke('lib:openFiles'),
  addPaths: paths => ipcRenderer.invoke('lib:addPaths', paths),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  getPlaylists: () => ipcRenderer.invoke('pl:get'),
  savePlaylists: pls => ipcRenderer.invoke('pl:save', pls),
  reveal: id => ipcRenderer.invoke('shell:reveal', id),
  onScanProgress: cb => ipcRenderer.on('scan-progress', (_e, d) => cb(d)),
  onOpenTracks: cb => ipcRenderer.on('open-tracks', (_e, ids) => cb(ids))
});
