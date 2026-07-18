const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

let mainWindow;
const controllerStreams = new Map();
let controllerPermissionWarningSent = false;
let runningGame = null;
let installingPackages = false;

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

function uniqueExistingDirectories(directories) {
  const seen = new Set();
  return directories.filter(directory => {
    if (!directory || !fs.existsSync(directory)) return false;
    let key;
    try { key = fs.realpathSync(directory); }
    catch { key = path.resolve(directory); }
    if (process.platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rpcs3Locations(rpcs3Path) {
  const executableDirectory = rpcs3Path ? path.dirname(rpcs3Path) : '';
  const home = app.getPath('home');
  const locations = [
    { config: path.join(executableDirectory, 'config', 'vfs.yml'), emulator: executableDirectory },
    { config: path.join(executableDirectory, 'vfs.yml'), emulator: executableDirectory }
  ];

  if (process.platform === 'linux') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    locations.push(
      { config: path.join(configHome, 'rpcs3', 'vfs.yml'), emulator: path.join(configHome, 'rpcs3') },
      { config: path.join(home, '.var', 'app', 'net.rpcs3.RPCS3', 'config', 'rpcs3', 'vfs.yml'), emulator: path.join(home, '.var', 'app', 'net.rpcs3.RPCS3', 'config', 'rpcs3') }
    );
  } else if (process.platform === 'darwin') {
    const dataDirectory = path.join(home, 'Library', 'Application Support', 'rpcs3');
    locations.push({ config: path.join(dataDirectory, 'vfs.yml'), emulator: dataDirectory });
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    locations.push(
      { config: path.join(appData, 'rpcs3', 'vfs.yml'), emulator: path.join(appData, 'rpcs3') },
      { config: path.join(appData, 'RPCS3', 'vfs.yml'), emulator: path.join(appData, 'RPCS3') }
    );
  }

  return locations.filter(location => location.emulator);
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function configuredHdd0(location) {
  if (!fs.existsSync(location.config)) return '';
  try {
    const vfs = fs.readFileSync(location.config, 'utf8');
    const value = vfs.match(/^\/dev_hdd0\/:\s*(.+?)\s*$/m)?.[1];
    if (!value) return '';
    const expanded = yamlScalar(value)
      .replace(/\$\(EmulatorDir\)/g, `${location.emulator}${path.sep}`)
      .replace(/\$\(ConfigDir\)/g, `${path.dirname(location.config)}${path.sep}`);
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(location.emulator, expanded);
  } catch {
    return '';
  }
}

function rpcs3GameDirectories(settings) {
  const discovered = [];
  for (const location of rpcs3Locations(settings.rpcs3Path)) {
    const hdd0 = configuredHdd0(location) || path.join(location.emulator, 'dev_hdd0');
    discovered.push(path.join(hdd0, 'game'));
  }
  return uniqueExistingDirectories(discovered);
}

function gameDirectories(settings) {
  return uniqueExistingDirectories([settings.gamesPath, ...rpcs3GameDirectories(settings)]);
}

function pathIsInside(childPath, parentPath) {
  let child = path.resolve(childPath);
  let parent = path.resolve(parentPath);
  if (process.platform === 'win32') {
    child = child.toLowerCase();
    parent = parent.toLowerCase();
  }
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function listGames(settings) {
  const games = [];
  const installedRoots = rpcs3GameDirectories(settings);
  for (const directory of gameDirectories(settings)) walkGames(directory, games);
  const seen = new Set();
  return games
    .filter(game => {
      let key;
      try { key = fs.realpathSync(game.path); }
      catch { key = path.resolve(game.path); }
      if (process.platform === 'win32') key = key.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(game => ({
      ...game,
      removable: game.kind === 'installed' && installedRoots.some(directory => pathIsInside(game.rootPath, directory))
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function sendInstallProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('packages:progress', progress);
  }
}

function installPackage(rpcs3Path, filePath, index, total) {
  return new Promise(resolve => {
    sendInstallProgress({ status: 'installing', file: path.basename(filePath), index, total });
    const child = spawn(rpcs3Path, ['--headless', '--installpkg', filePath], {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const collect = chunk => {
      output += chunk.toString();
      if (output.length > 12000) output = output.slice(-12000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => {
      sendInstallProgress({ status: 'error', file: path.basename(filePath), index, total, message: error.message });
      finish({ file: filePath, ok: false, message: error.message });
    });
    child.once('close', code => {
      if (settled) return;
      const ok = code === 0;
      const fallback = ok
        ? 'Instalação concluída.'
        : `O RPCS3 encerrou com o código ${code}. Verifique se a versão instalada oferece suporte à instalação headless.`;
      const message = output.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || fallback;
      sendInstallProgress({ status: ok ? 'success' : 'error', file: path.basename(filePath), index, total, message });
      finish({ file: filePath, ok, message });
    });
  });
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
        rootPath: fullPath,
        kind: 'iso',
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
          rootPath: fullPath,
          kind: isInstalledGame ? 'installed' : 'disc',
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
  ipcMain.handle('games:list', () => listGames(getSettings()));
  ipcMain.handle('packages:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecionar conteúdo para instalar',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Conteúdo do RPCS3', extensions: ['pkg', 'rap', 'edat'] },
        { name: 'Pacotes PKG', extensions: ['pkg'] },
        { name: 'Licenças RAP e EDAT', extensions: ['rap', 'edat'] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('packages:install', async (_event, requestedFiles) => {
    const { rpcs3Path } = getSettings();
    if (!rpcs3Path || !fs.existsSync(rpcs3Path)) {
      return { ok: false, message: 'Selecione o executável do RPCS3 nas configurações.' };
    }
    if (runningGame && !runningGame.killed) {
      return { ok: false, message: 'Feche o jogo em execução antes de instalar conteúdo.' };
    }
    if (installingPackages) {
      return { ok: false, message: 'Já existe uma instalação em andamento.' };
    }

    const files = Array.isArray(requestedFiles)
      ? requestedFiles
        .filter(file => typeof file === 'string' && /\.(pkg|rap|edat)$/i.test(file) && fs.existsSync(file))
        .slice(0, 100)
      : [];
    if (!files.length) return { ok: false, message: 'Nenhum arquivo PKG, RAP ou EDAT válido foi selecionado.' };

    installingPackages = true;
    const results = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        results.push(await installPackage(rpcs3Path, files[index], index + 1, files.length));
      }
    } finally {
      installingPackages = false;
    }
    const failed = results.filter(result => !result.ok);
    return {
      ok: failed.length === 0,
      results,
      message: failed.length
        ? `${results.length - failed.length} de ${results.length} arquivo(s) instalado(s).`
        : `${results.length} arquivo(s) instalado(s) com sucesso.`
    };
  });
  ipcMain.handle('game:launch', (_event, gamePath) => {
    const { rpcs3Path } = getSettings();
    if (!rpcs3Path || !fs.existsSync(rpcs3Path)) return { ok: false, message: 'Selecione o executável do RPCS3 nas configurações.' };
    if (installingPackages) return { ok: false, message: 'Aguarde a instalação de conteúdo terminar.' };
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
  ipcMain.handle('game:open-folder', async (_event, gamePath) => {
    const game = listGames(getSettings()).find(candidate => candidate.path === gamePath);
    if (!game?.rootPath || !fs.existsSync(game.rootPath)) {
      return { ok: false, message: 'A pasta deste jogo não foi encontrada.' };
    }
    if (game.kind === 'iso') {
      shell.showItemInFolder(game.rootPath);
      return { ok: true };
    }
    const error = await shell.openPath(game.rootPath);
    return error ? { ok: false, message: error } : { ok: true };
  });
  ipcMain.handle('game:remove-installed', async (_event, gamePath) => {
    if (runningGame && !runningGame.killed) {
      return { ok: false, message: 'Feche o jogo em execução antes de removê-lo.' };
    }
    if (installingPackages) {
      return { ok: false, message: 'Aguarde a instalação de conteúdo terminar.' };
    }

    const settings = getSettings();
    const game = listGames(settings).find(candidate => candidate.path === gamePath);
    const allowedRoots = rpcs3GameDirectories(settings);
    const canRemove = game?.kind === 'installed'
      && game.rootPath
      && allowedRoots.some(directory => pathIsInside(game.rootPath, directory));
    if (!canRemove) {
      return { ok: false, message: 'Somente jogos instalados no dev_hdd0 do RPCS3 podem ser removidos por aqui.' };
    }

    try {
      await fs.promises.rm(game.rootPath, { recursive: true, force: false });
      return { ok: true, message: `${game.title} foi removido do HDD do RPCS3.` };
    } catch (error) {
      return { ok: false, message: `Não foi possível remover o jogo: ${error.message}` };
    }
  });
  ipcMain.handle('folder:open', () => shell.openPath(getSettings().gamesPath));
  createWindow();
  scanLinuxControllers();
  const controllerScanner = setInterval(scanLinuxControllers, 5000);
  controllerScanner.unref();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
