const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('ghostTrigger', () => {
  ipcRenderer.send('trigger-fired');
});
