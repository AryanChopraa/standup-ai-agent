const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openMeet:   (config) => ipcRenderer.send('open-meet', config),
  deliverNow: ()       => ipcRenderer.send('deliver-now'),
  cancelRun:  ()       => ipcRenderer.send('cancel-run'),
  onLog:      (cb) => ipcRenderer.on('log',       (e, msg)    => cb(msg)),
  onRunDone:  (cb) => ipcRenderer.on('run-done',  (e, status) => cb(status)),
  onMeetOpen: (cb) => ipcRenderer.on('meet-open', (e)         => cb()),
});
