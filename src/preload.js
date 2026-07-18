const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbis', {
  quit: () => ipcRenderer.invoke('app:quit'),
  settings: () => ipcRenderer.invoke('settings:get'),
  chooseRpcs3: () => ipcRenderer.invoke('settings:choose-rpcs3'),
  chooseGames: () => ipcRenderer.invoke('settings:choose-games'),
  chooseMusic: () => ipcRenderer.invoke('settings:choose-music'),
  music: () => ipcRenderer.invoke('music:list'),
  games: () => ipcRenderer.invoke('games:list'),
  chooseInstallFiles: () => ipcRenderer.invoke('packages:choose'),
  installPackages: files => ipcRenderer.invoke('packages:install', files),
  launch: (gamePath) => ipcRenderer.invoke('game:launch', gamePath),
  openGameFolder: gamePath => ipcRenderer.invoke('game:open-folder', gamePath),
  removeInstalledGame: gamePath => ipcRenderer.invoke('game:remove-installed', gamePath),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  onInstallProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('packages:progress', listener);
    return () => ipcRenderer.removeListener('packages:progress', listener);
  },
  onGameStopped: callback => {
    const listener = () => callback();
    ipcRenderer.on('game:stopped', listener);
    return () => ipcRenderer.removeListener('game:stopped', listener);
  },
  onControllerAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('controller:action', listener);
    return () => ipcRenderer.removeListener('controller:action', listener);
  },
  onControllerStatus: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('controller:status', listener);
    return () => ipcRenderer.removeListener('controller:status', listener);
  }
});
