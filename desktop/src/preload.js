const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirrorLink', {
  connect: settings => ipcRenderer.invoke('connect', settings),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  openPopout: () => ipcRenderer.invoke('open-popout'),
  closePopout: () => ipcRenderer.invoke('close-popout'),
  getPopoutStatus: () => ipcRenderer.invoke('get-popout-status'),
  ackFrame: () => ipcRenderer.send('frame-ack'),
  onStatus: cb => ipcRenderer.on('status', (_, v) => cb(v)),
  onVideoSize: cb => ipcRenderer.on('video-size', (_, v) => cb(v)),
  onFrame: cb => ipcRenderer.on('frame', (_, v) => cb(v)),
  onPopoutStatus: cb => ipcRenderer.on('popout-status', (_, v) => cb(v))
});
