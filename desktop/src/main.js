const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execFileAsync = promisify(execFile);
const PORT = 27183;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
let mainWindow = null;
let popoutWindow = null;
let session = null; // one active session at a time

// IPC Flow-control state: ensure zero queue buildup across Electron IPC
let mainInFlight = false;
let popoutInFlight = false;
let pendingMainFrame = null;
let pendingPopoutFrame = null;

function resetFrameQueue() {
  mainInFlight = false;
  popoutInFlight = false;
  pendingMainFrame = null;
  pendingPopoutFrame = null;
}

// Augment process.env.PATH with common tool directories (Android SDK, Homebrew, FFmpeg, etc.)
function augmentPath() {
  const extraDirs = [
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools'),
    path.join(os.homedir(), 'Android/Sdk/platform-tools'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    'C:\\ffmpeg\\bin',
    path.join(os.homedir(), 'ffmpeg', 'bin'),
    path.join(process.env.LOCALAPPDATA || '', 'ffmpeg', 'bin'),
    'C:\\Program Files\\ffmpeg\\bin'
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

  // Check local.properties from android project directory
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

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (dir) candidates.push(path.join(dir, binaryName));
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) { }
  }

  return 'adb';
}

function findFfmpeg() {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];

  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);

  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/ffmpeg');
    candidates.push('/usr/local/bin/ffmpeg');
  } else if (isWin) {
    candidates.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
    candidates.push(path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'));
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin', 'ffmpeg.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'ffmpeg.exe'));
    }
    if (process.env.PROGRAMFILES) {
      candidates.push(path.join(process.env.PROGRAMFILES, 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
  } else {
    candidates.push('/usr/bin/ffmpeg');
    candidates.push('/usr/local/bin/ffmpeg');
  }

  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (dir) candidates.push(path.join(dir, binaryName));
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) { }
  }

  return 'ffmpeg';
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

function sendStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', message);
  if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.webContents.send('status', message);
}

function sendVideoSize(header) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video-size', header);
  if (popoutWindow && !popoutWindow.isDestroyed()) popoutWindow.webContents.send('video-size', header);
}

function pushLatestFrame(frame) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainInFlight) {
      mainInFlight = true;
      mainWindow.webContents.send('frame', frame);
    } else {
      pendingMainFrame = frame;
    }
  }

  if (popoutWindow && !popoutWindow.isDestroyed()) {
    if (!popoutInFlight) {
      popoutInFlight = true;
      popoutWindow.webContents.send('frame', frame);
    } else {
      pendingPopoutFrame = frame;
    }
  }
}

// Flow control: Renderer acknowledges it has finished displaying the frame.
ipcMain.on('frame-ack', (event) => {
  const isPopout = popoutWindow && !popoutWindow.isDestroyed() && event.sender === popoutWindow.webContents;
  if (isPopout) {
    if (pendingPopoutFrame && popoutWindow && !popoutWindow.isDestroyed()) {
      const next = pendingPopoutFrame;
      pendingPopoutFrame = null;
      popoutWindow.webContents.send('frame', next);
    } else {
      popoutInFlight = false;
    }
  } else {
    if (pendingMainFrame && mainWindow && !mainWindow.isDestroyed()) {
      const next = pendingMainFrame;
      pendingMainFrame = null;
      mainWindow.webContents.send('frame', next);
    } else {
      mainInFlight = false;
    }
  }
});

// ---- session lifecycle (every handler is bound to its own session object) ----
async function endSession(s, message) {
  resetFrameQueue();
  if (!s || s.closed) return;
  s.closed = true;
  if (session === s) session = null;
  s.socket?.destroy();
  if (s.ffmpeg) {
    try { s.ffmpeg.stdin.destroy(); } catch (_) { }
    s.ffmpeg.kill();
  }
  if (message) sendStatus(message);
  if (s.serial) {
    try { await adb(['-s', s.serial, 'forward', '--remove', `tcp:${PORT}`]); } catch (_) { }
  }
}

async function connect(settings = {}) {
  if (session) await endSession(session);
  resetFrameQueue();

  const serial = await connectedDevice();
  await adb(['-s', serial, 'forward', `tcp:${PORT}`, `tcp:${PORT}`]);

  const s = {
    serial, socket: null, ffmpeg: null, closed: false,
    pending: Buffer.alloc(0), header: null, started: false, hadError: false,
    spsPps: null, firstKeyframe: null
  };
  s.settings = {
    maxEdge: [640, 960, 1280, 1920].includes(Number(settings.maxEdge)) ? Number(settings.maxEdge) : 0,
    fps: [15, 24, 30, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 0
  };
  session = s;
  sendStatus(`Connected to ${serial}. Waiting for screen stream…`);

  s.socket = net.createConnection({ host: '127.0.0.1', port: PORT });
  s.socket.setNoDelay(true);

  s.socket.on('connect', () => {
    if (!s.closed) sendStatus(`Connected to ${serial}. Requesting screen stream…`);
  });

  s.socket.on('error', error => {
    if (s.closed) return;
    s.hadError = true;
    sendStatus(error.code === 'ECONNREFUSED'
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
      startDecoder(s, s.header);
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
        s.spsPps = null;
        s.firstKeyframe = null;
        startDecoder(s, s.header);
        continue;
      }
      if (size > MAX_FRAME_BYTES) {
        s.hadError = true;
        return void endSession(s, 'Invalid video frame received.');
      }
      if (s.pending.length < size + 4) break;
      const packet = s.pending.subarray(4, size + 4);

      // Inspect NAL type (3-byte or 4-byte start codes)
      const nalType = (packet.length >= 5 && packet[0] === 0 && packet[1] === 0 && packet[2] === 0 && packet[3] === 1)
        ? (packet[4] & 0x1f)
        : (packet.length >= 4 && packet[0] === 0 && packet[1] === 0 && packet[2] === 1)
          ? (packet[3] & 0x1f)
          : 0;

      if (nalType === 7) {
        s.spsPps = Buffer.from(packet);
      } else if (nalType === 5) {
        if (!s.firstKeyframe) s.firstKeyframe = Buffer.from(packet);
      }

      if (s.ffmpeg && !s.ffmpeg.stdin.destroyed && s.ffmpeg.stdin.writable) {
        s.ffmpeg.stdin.write(packet);
      }
      s.pending = s.pending.subarray(size + 4);
    }
  });

  s.socket.on('close', () => {
    if (s.closed) return; // superseded or manually disconnected
    endSession(s, s.hadError ? undefined
      : s.started ? 'Phone stopped sharing.'
        : 'Connection closed before stream began. Ensure "Start sharing" was accepted on phone and tap Connect again.');
  });
}

function startDecoder(s, { width, height, fps }) {
  resetFrameQueue();
  const scale = s.settings.maxEdge ? Math.min(1, s.settings.maxEdge / Math.max(width, height)) : 1;
  const outputWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
  const outputHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
  s.outputHeader = { ...s.header, width: outputWidth, height: outputHeight };
  const filters = [];
  if (outputWidth !== width || outputHeight !== height) filters.push(`scale=${outputWidth}:${outputHeight}:flags=fast_bilinear`);
  const args = [
    '-loglevel', 'error',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-fpsprobesize', '0',
    '-flags', 'low_delay',
    '-threads', '1',
    '-f', 'h264',
    '-i', 'pipe:0',
    '-an'
  ];
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
  const previousDecoder = s.ffmpeg;
  const ff = spawn(findFfmpeg(), args);
  s.ffmpeg = ff;
  if (previousDecoder) {
    try { previousDecoder.stdin.destroy(); } catch (_) { }
    previousDecoder.kill();
  }

  ff.on('error', err => {
    endSession(s, `FFmpeg error (${err.message}). Make sure FFmpeg is installed.`);
  });
  ff.stdin.on('error', () => { }); // EPIPE when ffmpeg exits / session ends
  ff.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg) console.error('[FFmpeg]', msg);
  });
  ff.on('close', () => {
    if (!s.closed && s.ffmpeg === ff) endSession(s, 'Video decoder stopped.');
  });

  // Collect chunks and concat once per frame
  const frameBytes = outputWidth * outputHeight * 4;
  let chunks = [];
  let buffered = 0;
  let framesDecoded = 0;
  let lastFrameDispatchAt = 0;
  const minFrameInterval = s.settings.fps ? 1000 / s.settings.fps : 0;

  ff.stdout.on('data', data => {
    if (s.closed) return;
    chunks.push(data);
    buffered += data.length;
    let newestFrame = null;
    while (buffered >= frameBytes) {
      framesDecoded++;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      newestFrame = Buffer.from(all.subarray(0, frameBytes));
      const rest = all.subarray(frameBytes);
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
    }
    // Only dispatch the newest decoded frame; drop any stale burst frames!
    if (newestFrame) {
      const now = Date.now();
      if (!minFrameInterval || now - lastFrameDispatchAt >= minFrameInterval) {
        lastFrameDispatchAt = now;
        pushLatestFrame(newestFrame);
      }
    }
  });

  // FFmpeg's probe over a non-seekable pipe reads and consumes the initial SPS/PPS and keyframe.
  // Resend the buffered SPS/PPS and IDR frame after 250ms if decoding hasn't produced frames yet.
  setTimeout(() => {
    if (!s.closed && framesDecoded === 0 && s.ffmpeg && !s.ffmpeg.stdin.destroyed && s.ffmpeg.stdin.writable) {
      if (s.spsPps) s.ffmpeg.stdin.write(s.spsPps);
      if (s.firstKeyframe) s.ffmpeg.stdin.write(s.firstKeyframe);
    }
  }, 250);

  sendVideoSize({ width: outputWidth, height: outputHeight, fps });
  const sizeLabel = outputWidth === width && outputHeight === height ? 'Auto size' : `${outputWidth}×${outputHeight}`;
  const fpsLabel = s.settings.fps ? `up to ${s.settings.fps}fps` : `${fps || 'Auto'}fps`;
  sendStatus(`Live: ${sizeLabel} @ ${fpsLabel}.`);
}

function createPopoutWindow() {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return;
  }
  popoutWindow = new BrowserWindow({
    width: 900,
    height: 750,
    title: 'MirrorLink USB - Tab 2 (Detached)',
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
      popoutWindow.webContents.send('video-size', session.outputHeader || session.header);
      popoutWindow.webContents.send('status', `Live: ${session.outputHeader?.width || session.header.width}×${session.outputHeader?.height || session.header.height}`);
    }
  });

  popoutWindow.on('closed', () => {
    popoutWindow = null;
    popoutInFlight = false;
    pendingPopoutFrame = null;
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
    mainInFlight = false;
    pendingMainFrame = null;
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.close();
    }
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
    sendStatus(error.message);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('disconnect', async () => {
  await endSession(session);
  sendStatus('Disconnected.');
});

ipcMain.handle('open-popout', async () => {
  createPopoutWindow();
  return { ok: true };
});

ipcMain.handle('close-popout', async () => {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.close();
    popoutWindow = null;
  }
  return { ok: true };
});

ipcMain.handle('get-popout-status', async () => {
  return { isPoppedOut: !!(popoutWindow && !popoutWindow.isDestroyed()) };
});

app.on('before-quit', () => {
  endSession(session);
});
