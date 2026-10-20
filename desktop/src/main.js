const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execFileAsync = promisify(execFile);
const PORT = 27183;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
let mainWindow = null;
let session = null; // one active session at a time

// Augment process.env.PATH with common tool directories (Android SDK, Homebrew, etc.)
function augmentPath() {
  const extraDirs = [
    path.join(os.homedir(), 'Library/Android/sdk/platform-tools'),
    path.join(os.homedir(), 'Android/Sdk/platform-tools'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin'
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
  } else if (!isWin) {
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
}

function pushFrame(frame) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('frame', frame);
}

ipcMain.on('frame-ack', () => {
  // Kept for backward compatibility
});

// ---- session lifecycle (every handler is bound to its own session object) ----
async function endSession(s, message) {
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

async function connect() {
  if (session) await endSession(session);

  const serial = await connectedDevice();
  await adb(['-s', serial, 'forward', `tcp:${PORT}`, `tcp:${PORT}`]);

  const s = {
    serial, socket: null, ffmpeg: null, closed: false,
    pending: Buffer.alloc(0), header: null, started: false, hadError: false,
    spsPps: null, firstKeyframe: null
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
      if (version !== 1) {
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
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video-size', s.header);
      startDecoder(s, s.header);
    }

    while (s.header && s.pending.length >= 4) {
      const size = s.pending.readUInt32BE(0);
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
  const targetFps = fps || 30;
  const ff = spawn(findFfmpeg(), [
    '-loglevel', 'error',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-fpsprobesize', '0',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-threads', '1',
    '-f', 'h264',
    '-r', String(targetFps),
    '-i', 'pipe:0',
    '-an',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1'
  ]);
  s.ffmpeg = ff;

  ff.on('error', err => {
    endSession(s, `FFmpeg error (${err.message}). Make sure FFmpeg is installed (e.g. brew install ffmpeg).`);
  });
  ff.stdin.on('error', () => { }); // EPIPE when ffmpeg exits / session ends
  ff.stderr.on('data', data => {
    const msg = data.toString().trim();
    if (msg) console.error('[FFmpeg]', msg);
  });
  ff.on('close', () => {
    if (!s.closed) endSession(s, 'Video decoder stopped.');
  });

  // Collect chunks and concat once per frame (avoids O(n²) copying).
  const frameBytes = width * height * 4;
  let chunks = [];
  let buffered = 0;
  let framesDecoded = 0;

  ff.stdout.on('data', data => {
    if (s.closed) return;
    chunks.push(data);
    buffered += data.length;
    while (buffered >= frameBytes) {
      framesDecoded++;
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      const frame = Buffer.from(all.subarray(0, frameBytes)); // exact-size copy for IPC
      const rest = all.subarray(frameBytes);
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
      pushFrame(frame);
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

  sendStatus(`Streaming ${width}×${height}.`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 740,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
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

ipcMain.handle('connect', async () => {
  try {
    await connect();
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

app.on('before-quit', () => { endSession(session); });