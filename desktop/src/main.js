const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execFileAsync = promisify(execFile);
const PORT = 27183;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ACK_TIMEOUT_MS = 500;

let mainWindow = null;
let popoutWindow = null;
let session = null;

// Per-target IPC flow-control state with timeout protection
const ipcState = {
  main:   { inFlight: false, pending: null, timer: null },
  popout: { inFlight: false, pending: null, timer: null }
};

function resetIpcState() {
  for (const key of ['main', 'popout']) {
    const s = ipcState[key];
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.inFlight = false;
    s.pending = null;
  }
}

// Augment PATH with common tool directories
function augmentPath() {
  const extraDirs = [
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools'),
    path.join(os.homedir(), 'Android/Sdk/platform-tools'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    'C:\\platform-tools',
    path.join(process.env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools'),
    path.join(process.env.PROGRAMFILES || '', 'Android/android-sdk/platform-tools')
  ];
  const currentPath = process.env.PATH || '';
  const pathSet = new Set(currentPath.split(path.delimiter));
  const toAdd = extraDirs.filter(d => fs.existsSync(d) && !pathSet.has(d));
  if (toAdd.length > 0) {
    process.env.PATH = `${toAdd.join(path.delimiter)}${path.delimiter}${currentPath}`;
  }
}
augmentPath();

function findAdb() {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? 'adb.exe' : 'adb';
  const candidates = [];

  if (process.env.ADB_PATH) candidates.push(process.env.ADB_PATH);

  const localPropPaths = [
    path.join(__dirname, '../../android/local.properties'),
    path.join(__dirname, '../android/local.properties'),
    path.join(process.cwd(), 'android/local.properties'),
    path.join(process.cwd(), '../android/local.properties')
  ];
  for (const lp of localPropPaths) {
    if (fs.existsSync(lp)) {
      try {
        const content = fs.readFileSync(lp, 'utf8');
        const match = content.match(/^sdk\.dir\s*=\s*(.+)$/m);
        if (match) {
          candidates.push(path.join(match[1].trim(), 'platform-tools', binaryName));
        }
      } catch (_) { }
    }
  }

  if (process.env.ANDROID_HOME) candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', binaryName));
  if (process.env.ANDROID_SDK_ROOT) candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', binaryName));

  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library/Android/sdk/platform-tools', binaryName));
    candidates.push('/opt/homebrew/bin/adb');
    candidates.push('/usr/local/bin/adb');
  } else if (isWin) {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools', binaryName));
    if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, 'Android/android-sdk/platform-tools', binaryName));
  } else {
    candidates.push(path.join(os.homedir(), 'Android/Sdk/platform-tools', binaryName));
    candidates.push('/usr/bin/adb');
    candidates.push('/usr/local/bin/adb');
  }

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, binaryName));
  }

  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { }
  }
  return 'adb';
}

async function adb(args) {
  try {
    const { stdout } = await execFileAsync(findAdb(), args, { encoding: 'utf8', timeout: 10000 });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('ADB (Android Debug Bridge) was not found. Please install Android Platform Tools or add adb to your PATH.');
    }
    throw new Error(`adb ${args.join(' ')} failed: ${(error.stderr || error.message || '').toString().trim()}`);
  }
}

async function connectedDevice() {
  const output = await adb(['devices']);
  const parsed = output.split('\n').slice(1).map(l => l.trim()).filter(Boolean)
    .map(line => line.split(/\s+/)).filter(parts => parts.length >= 2);

  const device = parsed.find(([, state]) => state === 'device');
  if (device) return device[0];

  const unauthorized = parsed.find(([, state]) => state === 'unauthorized');
  if (unauthorized) {
    throw new Error(`Device ${unauthorized[0]} is unauthorized. Unlock your phone and accept the "Allow USB debugging" prompt.`);
  }
  const offline = parsed.find(([, state]) => state === 'offline');
  if (offline) {
    throw new Error(`Device ${offline[0]} is offline. Reconnect the USB cable or restart USB debugging.`);
  }
  throw new Error('No Android device found over USB. Ensure USB debugging is enabled and the phone is connected.');
}

// ---- structured status events ----
// state: 'idle' | 'connecting' | 'live' | 'error' | 'disconnected'
function sendStatus(state, message) {
  const payload = { state, message };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', payload);
  if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.webContents.send('status', payload);
}

function sendVideoSize(header) {
  const payload = { width: header.width, height: header.height, fps: header.fps };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video-size', payload);
  if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.webContents.send('video-size', payload);
}

// ---- IPC NAL dispatch with ack timeout ----
function dispatchNal(target, payload) {
  const win = target === 'main' ? mainWindow : popoutWindow;
  if (!win || win.isDestroyed()) return;
  const s = ipcState[target];
  if (!s.inFlight) {
    s.inFlight = true;
    win.webContents.send('nal', payload);
    armAckTimer(target);
  } else {
    s.pending = payload;
  }
}

function armAckTimer(target) {
  const s = ipcState[target];
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    // Renderer stalled (occluded, crashed, etc.) — release the slot
    const next = s.pending;
    s.pending = null;
    const win = target === 'main' ? mainWindow : popoutWindow;
    if (next && win && !win.isDestroyed()) {
      win.webContents.send('nal', next);
      armAckTimer(target);
    } else {
      s.inFlight = false;
    }
  }, ACK_TIMEOUT_MS);
}

function pushNal(payload) {
  dispatchNal('main', payload);
  dispatchNal('popout', payload);
}

ipcMain.on('frame-ack', (event) => {
  const isPopout = popoutWindow && !popoutWindow.isDestroyed() && event.sender === popoutWindow.webContents;
  const target = isPopout ? 'popout' : 'main';
  const s = ipcState[target];
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.pending) {
    const next = s.pending;
    s.pending = null;
    const win = isPopout ? popoutWindow : mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send('nal', next);
      armAckTimer(target);
      return;
    }
  }
  s.inFlight = false;
});

// ---- session lifecycle ----
async function endSession(s, message) {
  if (!s || s.closed) return;
  s.closed = true;
  if (session === s) session = null;
  s.socket?.destroy();
  resetIpcState();
  if (message) sendStatus('disconnected', message);
  if (s.serial) {
    try { await adb(['-s', s.serial, 'forward', '--remove', `tcp:${PORT}`]); } catch (_) { }
  }
}

// Scan an H.264 byte stream for NAL unit types (returns array of type bytes).
function scanNalTypes(buf) {
  const types = [];
  let i = 0;
  while (i + 3 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      if (i + 4 < buf.length) types.push(buf[i + 4] & 0x1f);
      i += 4;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (i + 3 < buf.length) types.push(buf[i + 3] & 0x1f);
      i += 3;
    } else {
      i++;
    }
  }
  return types;
}

async function connect(settings = {}) {
  if (session) await endSession(session);
  resetIpcState();

  const serial = await connectedDevice();
  try { await adb(['-s', serial, 'forward', '--remove', `tcp:${PORT}`]); } catch (_) { }
  await adb(['-s', serial, 'forward', `tcp:${PORT}`, `tcp:${PORT}`]);

  const s = {
    serial, socket: null, closed: false,
    pending: Buffer.alloc(0), header: null, started: false, hadError: false
  };
  session = s;
  sendStatus('connecting', `Connected to ${serial}. Waiting for screen stream…`);

  s.socket = net.createConnection({ host: '127.0.0.1', port: PORT });
  s.socket.setNoDelay(true);

  s.socket.on('connect', () => {
    if (!s.closed) sendStatus('connecting', `Connected to ${serial}. Requesting screen stream…`);
  });

  s.socket.on('error', error => {
    if (s.closed) return;
    s.hadError = true;
    sendStatus('error', error.code === 'ECONNREFUSED'
      ? 'Could not connect to MirrorLink on the phone. Make sure you tapped "Start sharing" in the phone app.'
      : `Connection error: ${error.message}`);
  });

  s.socket.on('data', chunk => {
    if (s.closed) return;
    s.pending = Buffer.concat([s.pending, chunk]);

    if (!s.header && s.pending.length >= 20) {
      if (s.pending.subarray(0, 4).toString('latin1') !== 'MLNK') {
        s.hadError = true;
        return void endSession(s, 'The connected app is not a MirrorLink USB sender.');
      }
      const version = s.pending.readUInt32BE(4);
      if (version !== 1 && version !== 2) {
        s.hadError = true;
        return void endSession(s, `Unsupported MirrorLink protocol version ${version}.`);
      }
      s.header = {
        version,
        width: s.pending.readUInt32BE(8),
        height: s.pending.readUInt32BE(12),
        fps: s.pending.readUInt32BE(16)
      };
      s.pending = s.pending.subarray(20);
      s.started = true;
      sendVideoSize(s.header);
      sendStatus('live', `Live: ${s.header.width}×${s.header.height} @ ${s.header.fps}fps.`);
    }

    while (s.header && s.pending.length >= 4) {
      const size = s.pending.readUInt32BE(0);
      if (size === 0) {
        if (s.header.version < 2) {
          s.hadError = true;
          return void endSession(s, 'The sender sent an unsupported screen size update.');
        }
        if (s.pending.length < 16) break;
        const width = s.pending.readUInt32BE(4);
        const height = s.pending.readUInt32BE(8);
        const nextFps = s.pending.readUInt32BE(12);
        s.pending = s.pending.subarray(16);
        if (!width || !height || width > 8192 || height > 8192) {
          s.hadError = true;
          return void endSession(s, 'The phone sent an invalid screen size update.');
        }
        s.header = { ...s.header, width, height, fps: nextFps };
        sendVideoSize(s.header);
        sendStatus('live', `Live: ${width}×${height} @ ${nextFps}fps.`);
        continue;
      }
      if (size > MAX_FRAME_BYTES) {
        s.hadError = true;
        return void endSession(s, 'Invalid video frame received.');
      }
      if (s.pending.length < size + 4) break;
      const packet = s.pending.subarray(4, size + 4);

      const nalTypes = scanNalTypes(packet);
      const isKey = nalTypes.includes(5); // IDR slice

      // Compressed payload is small (a few KB); make a clean copy for IPC.
      pushNal({
        data: Buffer.from(packet),
        isKey,
        length: packet.length
      });

      s.pending = s.pending.subarray(size + 4);
    }
  });

  s.socket.on('close', () => {
    if (s.closed) return;
    endSession(s, s.hadError ? undefined
      : s.started ? 'Phone stopped sharing.'
        : 'Connection closed before stream began. Ensure "Start sharing" was accepted on phone and tap Connect again.');
  });
}

function createPopoutWindow() {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return;
  }
  popoutWindow = new BrowserWindow({
    width: 900,
    height: 750,
    title: 'MirrorLink USB — Detached',
    backgroundColor: '#10131a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  popoutWindow.loadFile(path.join(__dirname, 'popout.html'));

  popoutWindow.webContents.on('did-finish-load', () => {
    if (session && session.header) {
      popoutWindow.webContents.send('video-size', session.header);
      popoutWindow.webContents.send('status', { state: 'live',
        message: `Live: ${session.header.width}×${session.header.height}` });
    }
  });

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    ipcState.popout.inFlight = false;
    ipcState.popout.pending = null;
    if (ipcState.popout.timer) { clearTimeout(ipcState.popout.timer); ipcState.popout.timer = null; }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('popout-status', { isPoppedOut: false });
    }
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('popout-status', { isPoppedOut: true });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    backgroundColor: '#10131a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    ipcState.main.inFlight = false;
    ipcState.main.pending = null;
    if (ipcState.main.timer) { clearTimeout(ipcState.main.timer); ipcState.main.timer = null; }
    if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.close();
    endSession(session);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('connect', async (_event, settings) => {
  try {
    await connect(settings);
    return { ok: true };
  } catch (error) {
    sendStatus('error', error.message);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('disconnect', async () => {
  await endSession(session);
  sendStatus('idle', 'Disconnected.');
});

ipcMain.handle('open-popout', async () => { createPopoutWindow(); return { ok: true }; });

ipcMain.handle('close-popout', async () => {
  if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.close();
  return { ok: true };
});

ipcMain.handle('get-popout-status', async () => ({
  isPoppedOut: !!(popoutWindow && !popoutWindow.isDestroyed())
}));

app.on('before-quit', () => { endSession(session); });