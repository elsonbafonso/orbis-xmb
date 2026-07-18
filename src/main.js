const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

let mainWindow;
const controllerStreams = new Map();
let controllerPermissionWarningSent = false;
let runningGame = null;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getSettings() {
  const defaults = { rpcs3Path: '', gamesPath: '', musicPath: '' };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return defaults; }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function firstExisting(paths) {
  const file = paths.find(candidate => fs.existsSync(candidate));
  return file ? pathToFileURL(file).href : '';
}

function gameArtwork(gamePath, isIso = false) {
  if (isIso) {
    const directory = path.dirname(gamePath);
    const name = path.basename(gamePath, path.extname(gamePath));
    const artwork = ['png', 'jpg', 'jpeg', 'webp'].map(extension => path.join(directory, `${name}.${extension}`));
    return { cover: firstExisting(artwork), background: '' };
  }

  const ps3Game = path.join(gamePath, 'PS3_GAME');
  return {
    cover: firstExisting([
      path.join(ps3Game, 'ICON0.PNG'),
      path.join(gamePath, 'ICON0.PNG')
    ]),
    background: firstExisting([
      path.join(ps3Game, 'PIC1.PNG'),
      path.join(ps3Game, 'PIC0.PNG'),
      path.join(gamePath, 'PIC1.PNG'),
      path.join(gamePath, 'PIC0.PNG')
    ])
  };
}

function readParamSfo(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 20 || buffer[0] !== 0 || buffer.toString('ascii', 1, 4) !== 'PSF') return {};
    const keyTableStart = buffer.readUInt32LE(8);
    const dataTableStart = buffer.readUInt32LE(12);
    const entries = buffer.readUInt32LE(16);
    const metadata = {};

    for (let index = 0; index < entries; index += 1) {
      const entry = 20 + index * 16;
      if (entry + 16 > buffer.length) break;
      const keyOffset = buffer.readUInt16LE(entry);
      const format = buffer.readUInt16LE(entry + 2);
      const dataLength = buffer.readUInt32LE(entry + 4);
      const dataOffset = buffer.readUInt32LE(entry + 12);
      const keyStart = keyTableStart + keyOffset;
      const keyEnd = buffer.indexOf(0, keyStart);
      const dataStart = dataTableStart + dataOffset;
      if (keyEnd < 0 || dataStart >= buffer.length) continue;
      const key = buffer.toString('utf8', keyStart, keyEnd);
      if (format === 0x0404 && dataStart + 4 <= buffer.length) {
        metadata[key] = buffer.readUInt32LE(dataStart);
      } else {
        metadata[key] = buffer
          .toString('utf8', dataStart, Math.min(dataStart + dataLength, buffer.length))
          .replace(/\0+$/, '')
          .trim();
      }
    }
    return metadata;
  } catch {
    return {};
  }
}

function walkGames(root, results = [], depth = 0) {
  if (!root || depth > 8 || !fs.existsSync(root)) return results;
  let items;
  try { items = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return results; }

  for (const item of items) {
    const fullPath = path.join(root, item.name);
    if (item.isFile() && /\.iso$/i.test(item.name)) {
      results.push({
        title: path.basename(item.name, path.extname(item.name)),
        path: fullPath,
        ...gameArtwork(fullPath, true)
      });
    }
    let isDirectory = item.isDirectory();
    if (item.isSymbolicLink()) {
      try { isDirectory = fs.statSync(fullPath).isDirectory(); } catch { isDirectory = false; }
    }
    if (isDirectory) {
      const discParam = path.join(fullPath, 'PS3_GAME', 'PARAM.SFO');
      const discEboot = path.join(fullPath, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN');
      const installedParam = path.join(fullPath, 'PARAM.SFO');
      const installedEboot = path.join(fullPath, 'USRDIR', 'EBOOT.BIN');
      const isDiscGame = fs.existsSync(discParam) || fs.existsSync(discEboot);
      const isInstalledGame = fs.existsSync(installedParam) && fs.existsSync(installedEboot);

      if (isDiscGame || isInstalledGame) {
        const metadata = readParamSfo(isDiscGame ? discParam : installedParam);
        results.push({
          title: metadata.TITLE || item.name.replace(/[._]/g, ' '),
          serial: metadata.TITLE_ID || '',
          path: isInstalledGame ? installedEboot : fullPath,
          ...gameArtwork(fullPath)
        });
      } else {
        walkGames(fullPath, results, depth + 1);
      }
    }
  }
  return results;
}

function listMusic(root, results = [], depth = 0) {
  if (!root || depth > 2 || !fs.existsSync(root)) return results;
  let items;
  try { items = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return results; }
  for (const item of items) {
    const fullPath = path.join(root, item.name);
    if (item.isFile() && /\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(item.name)) {
      results.push(pathToFileURL(fullPath).href);
    } else if (item.isDirectory()) {
      listMusic(fullPath, results, depth + 1);
    }
  }
  return results;
}

function sendControllerAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('controller:action', action);
  }
}

function handleInputEvent(device, type, code, value) {
  if (type === 1) {
    if (value === 0) device.pressed.delete(code);
    if (value !== 1) return;
    device.pressed.add(code);
    if (device.pressed.has(314) && device.pressed.has(315)) return sendControllerAction('exit');
    const actions = { 304: 'accept', 305: 'back', 307: 'options', 308: 'options', 315: 'refresh', 544: 'up', 545: 'down', 546: 'left', 547: 'right' };
    if (actions[code]) sendControllerAction(actions[code]);
    return;
  }
  if (type !== 3 || ![0, 1, 16, 17].includes(code)) return;

  const threshold = code >= 16 ? 0 : 12000;
  const direction = value < -threshold
    ? (code === 0 || code === 16 ? 'left' : 'up')
    : value > threshold
      ? (code === 0 || code === 16 ? 'right' : 'down')
      : '';
  if (direction && device.axes[code] !== direction) sendControllerAction(direction);
  device.axes[code] = direction;
}

function openControllerDevice(devicePath) {
  if (controllerStreams.has(devicePath)) return;
  const device = { buffer: Buffer.alloc(0), pressed: new Set(), axes: {} };
  const stream = fs.createReadStream(devicePath);
  controllerStreams.set(devicePath, stream);
  stream.on('data', chunk => {
    device.buffer = Buffer.concat([device.buffer, chunk]);
    while (device.buffer.length >= 24) {
      const event = device.buffer.subarray(0, 24);
      device.buffer = device.buffer.subarray(24);
      handleInputEvent(device, event.readUInt16LE(16), event.readUInt16LE(18), event.readInt32LE(20));
    }
  });
  stream.on('error', error => {
    controllerStreams.delete(devicePath);
    if (error.code === 'EACCES' && !controllerPermissionWarningSent) {
      controllerPermissionWarningSent = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('controller:status', 'Sem permissão para acessar o controle em /dev/input.');
      }
    }
  });
  stream.on('close', () => controllerStreams.delete(devicePath));
}

function scanLinuxControllers() {
  if (process.platform !== 'linux') return;
  let devices;
  try { devices = fs.readFileSync('/proc/bus/input/devices', 'utf8'); }
  catch { return; }

  for (const block of devices.split(/\n\n+/)) {
    const name = block.match(/N: Name="(.+)"/)?.[1] || '';
    const handlers = block.match(/H: Handlers=(.+)/)?.[1] || '';
    const looksLikeController = /\bjs\d+\b/.test(handlers) || /gamepad|x-?box|controller|rog ally|dualshock|dualsense|hhd/i.test(name);
    if (!looksLikeController) continue;
    for (const event of handlers.match(/\bevent\d+\b/g) || []) {
      openControllerDevice(`/dev/input/${event}`);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 720, minWidth: 960, minHeight: 580,
    backgroundColor: '#061325', autoHideMenuBar: true,
    fullscreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:choose-rpcs3', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Executável', extensions: ['AppImage', 'x86_64', 'bin', 'exe'] }, { name: 'Todos os arquivos', extensions: ['*'] }] });
    if (result.canceled) return null;
    const settings = getSettings(); settings.rpcs3Path = result.filePaths[0]; saveSettings(settings); return settings;
  });
  ipcMain.handle('settings:choose-games', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const settings = getSettings(); settings.gamesPath = result.filePaths[0]; saveSettings(settings); return settings;
  });
  ipcMain.handle('settings:choose-music', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const settings = getSettings(); settings.musicPath = result.filePaths[0]; saveSettings(settings); return settings;
  });
  ipcMain.handle('music:list', () => listMusic(getSettings().musicPath));
  ipcMain.handle('games:list', () => walkGames(getSettings().gamesPath).sort((a, b) => a.title.localeCompare(b.title)));
  ipcMain.handle('game:launch', (_event, gamePath) => {
    const { rpcs3Path } = getSettings();
    if (!rpcs3Path || !fs.existsSync(rpcs3Path)) return { ok: false, message: 'Selecione o executável do RPCS3 nas configurações.' };
    try {
      if (runningGame && !runningGame.killed) {
        try { runningGame.kill(); } catch {}
      }
      const child = spawn(rpcs3Path, ['--no-gui', '--fullscreen', gamePath], { detached: true, stdio: 'ignore' });
      runningGame = child;
      child.on('exit', () => {
        if (runningGame === child) runningGame = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('game:stopped');
        }
      });
      child.on('error', () => {
        if (runningGame === child) runningGame = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('game:stopped');
        }
      });
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; }
  });
  ipcMain.handle('folder:open', () => shell.openPath(getSettings().gamesPath));
  createWindow();
  scanLinuxControllers();
  const controllerScanner = setInterval(scanLinuxControllers, 5000);
  controllerScanner.unref();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
