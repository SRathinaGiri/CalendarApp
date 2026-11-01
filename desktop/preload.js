// Gives the page the same small "Capacitor" interface the Android app has, backed by
// the main process. Nothing else from Node or Electron is exposed to the page.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const fsCall = (op) => (args) => ipcRenderer.invoke('srg:fs', op, args || {});

contextBridge.exposeInMainWorld('SRG_PLATFORM', 'windows');
contextBridge.exposeInMainWorld('Capacitor', {
  isNativePlatform: () => true,
  getPlatform: () => 'windows',
  Plugins: {
    Filesystem: {
      writeFile: fsCall('writeFile'),
      readFile: fsCall('readFile'),
      deleteFile: fsCall('deleteFile'),
      readdir: fsCall('readdir'),
      rename: fsCall('rename'),
      getUri: fsCall('getUri'),
      requestPermissions: fsCall('requestPermissions'),
      checkPermissions: fsCall('checkPermissions'),
    },
    Share: {
      share: (args) => ipcRenderer.invoke('srg:share', args || {}),
    },
  },
});
