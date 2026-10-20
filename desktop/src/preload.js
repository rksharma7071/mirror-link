const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mirrorLink', {
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  ackFrame: () => ipcRenderer.send('frame-ack'),
  onStatus: cb => ipcRenderer.on('status', (_, v) => cb(v)),
  onVideoSize: cb => ipcRenderer.on('video-size', (_, v) => cb(v)),
  onFrame: cb => ipcRenderer.on('frame', (_, v) => cb(v))
});