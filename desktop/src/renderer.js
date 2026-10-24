// ── DOM refs ─────────────────────────────────────────────────────────────
const statusText = document.getElementById('status');
const statusDot = document.getElementById('statusDot');
const resBadge = document.getElementById('resBadge');
const fpsDisplay = document.getElementById('fpsDisplay');
const streamStats = document.getElementById('streamStats');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const detachButton = document.getElementById('detach');
const resolutionSelect = document.getElementById('resolutionSelect');
const fpsSelect = document.getElementById('fpsSelect');

// ── Preferences ──────────────────────────────────────────────────────────
for (const [key, select] of [['mirrorlink-resolution', resolutionSelect], ['mirrorlink-fps', fpsSelect]]) {
  const saved = localStorage.getItem(key);
  if (saved && [...select.options].some(o => o.value === saved)) select.value = saved;
  select.addEventListener('change', () => localStorage.setItem(key, select.value));
}

// ── Canvas / layout refs ─────────────────────────────────────────────────
const canvas1 = document.getElementById('screen1');
const ctx1 = canvas1.getContext('2d', { alpha: false, desynchronized: true });
const pane1 = document.getElementById('pane1');
const orientBadge1 = document.getElementById('orientBadge1');
const orientBadgeText = document.getElementById('orientBadgeText');
const rotateOverlay1 = document.getElementById('rotateOverlay1');
const rotateIcon1 = document.getElementById('rotateIcon1');
const rotateLabelText = document.getElementById('rotateLabelText');
const rotateDimTag = document.getElementById('rotateDimTag');

const SVG_TO_LANDSCAPE = `
<svg class="orient-svg" width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="6" width="18" height="30" rx="3" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="22" y1="33" x2="28" y2="33" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 38 16 C 50 10 62 20 58 36" fill="none" stroke="#3fb950" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="3 2"/>
  <polygon points="55,40 63,33 62,42" fill="#3fb950"/>
  <rect x="38" y="36" width="26" height="15" rx="3" fill="none" stroke="#3fb950" stroke-width="2.2" stroke-linejoin="round" opacity="0.75"/>
  <line x1="56" y1="40" x2="56" y2="47" stroke="#3fb950" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
</svg>`;

const SVG_TO_PORTRAIT = `
<svg class="orient-svg" width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="28" width="26" height="15" rx="3" fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="27" y1="32" x2="27" y2="39" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 36 28 C 46 18 58 24 56 12" fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="3 2"/>
  <polygon points="52,8 60,14 53,18" fill="#58a6ff"/>
  <rect x="42" y="6" width="18" height="30" rx="3" fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linejoin="round" opacity="0.75"/>
  <line x1="48" y1="33" x2="54" y2="33" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
</svg>`;

let videoWidth = 0;
let videoHeight = 0;
let currentOrientation = null;

// ── WebCodecs decoder ────────────────────────────────────────────────────
let decoder = null;
let decoderCodec = null;
let decoderReady = false;

let nextTimestampUs = 0;
function getTimestamp() {
  const now = Math.round(performance.now() * 1000);
  nextTimestampUs = Math.max(nextTimestampUs + 1, now);
  return nextTimestampUs;
}

async function setupDecoder() {
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
    decoderReady = false;
  }
  const candidates = [
    'avc1.64002a', // High 4.2
    'avc1.640028', // High 4.0
    'avc1.4D4028', // Main 4.0
    'avc1.42E01E'  // Baseline 3.0
  ];
  decoderCodec = null;
  for (const codec of candidates) {
    try {
      const support = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
      if (support.supported) { decoderCodec = codec; break; }
    } catch (_) { /* try next */ }
  }
  if (!decoderCodec) {
    console.error('No supported H.264 codec found');
    statusText.textContent = 'Error: no H.264 decoder available in this Electron build';
    return false;
  }

  decoder = new VideoDecoder({
    output(frame) {
      try {
        drawFrame(frame);
      } finally {
        frame.close();
        window.mirrorLink.ackFrame();
      }
    },
    error(e) {
      console.error('VideoDecoder error:', e);
      // Attempt graceful recovery: reconfigure so subsequent keyframes decode
      if (decoder && decoderCodec) {
        try { decoder.configure({ codec: decoderCodec, optimizeForLatency: true }); }
        catch (err) { console.error('Reconfigure failed:', err); }
      }
      window.mirrorLink.ackFrame();
    }
  });
  decoder.configure({ codec: decoderCodec, optimizeForLatency: true });
  decoderReady = true;
  return true;
}

function drawFrame(frame) {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  if (canvas1.width !== w || canvas1.height !== h) {
    canvas1.width = w;
    canvas1.height = h;
  }
  ctx1.drawImage(frame, 0, 0, w, h);

  frameCounter++;
  const now = performance.now();
  if (now - lastFpsUpdateTime >= 1000) {
    const fps = Math.round((frameCounter * 1000) / (now - lastFpsUpdateTime));
    fpsDisplay.textContent = `${fps} FPS • Live`;
    frameCounter = 0;
    lastFpsUpdateTime = now;
  }
}

let frameCounter = 0;
let lastFpsUpdateTime = performance.now();

// ── NAL input ────────────────────────────────────────────────────────────
function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  throw new Error('Unexpected NAL data type');
}

window.mirrorLink.onNal(({ data, isKey }) => {
  if (!decoder || !decoderReady) {
    window.mirrorLink.ackFrame();
    return;
  }
  // Backpressure: skip deltas if decoder queue is saturated (never drop keyframes)
  if (decoder.decodeQueueSize > 8 && !isKey) {
    window.mirrorLink.ackFrame();
    return;
  }
  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: getTimestamp(),
      data: toUint8(data)
    }));
  } catch (err) {
    console.error('Decode push failed:', err);
  }
  window.mirrorLink.ackFrame();
});

// ── Status handling ──────────────────────────────────────────────────────
window.mirrorLink.onStatus(({ state, message }) => {
  statusText.textContent = message;
  const live = state === 'live' || state === 'connecting';
  connectButton.classList.toggle('hidden', live);
  disconnectButton.classList.toggle('hidden', !live);
  streamStats.classList.toggle('hidden', state !== 'live');
  detachButton.classList.toggle('hidden', state !== 'live');
  statusDot.className = 'status-dot';
  if (state === 'live') statusDot.classList.add('active');
  else if (state === 'error') statusDot.classList.add('error');
});

// ── Video size handling ──────────────────────────────────────────────────
window.mirrorLink.onVideoSize(({ width, height }) => {
  videoWidth = width;
  videoHeight = height;
  resBadge.textContent = `${width}×${height}`;
  resBadge.classList.remove('hidden');
  applyOrientation(width, height);
});

// ── Orientation ──────────────────────────────────────────────────────────
let rotateOverlayTimer = null;
function applyOrientation(width, height) {
  const newOrientation = width >= height ? 'landscape' : 'portrait';
  const changed = newOrientation !== currentOrientation;
  currentOrientation = newOrientation;
  const isLandscape = newOrientation === 'landscape';

  pane1.classList.toggle('orient-landscape', isLandscape);
  pane1.classList.toggle('orient-portrait', !isLandscape);

  if (orientBadgeText) orientBadgeText.textContent = isLandscape ? 'Landscape' : 'Portrait';
  if (orientBadge1) orientBadge1.classList.toggle('landscape', isLandscape);

  if (changed && rotateOverlay1) {
    if (rotateOverlayTimer) clearTimeout(rotateOverlayTimer);
    if (rotateIcon1) {
      rotateIcon1.innerHTML = isLandscape ? SVG_TO_LANDSCAPE : SVG_TO_PORTRAIT;
      const svg = rotateIcon1.querySelector('svg');
      if (svg) {
        svg.style.animation = 'none';
        void svg.offsetWidth;
        svg.style.animation = '';
      }
    }
    if (rotateLabelText) rotateLabelText.textContent = isLandscape ? 'Switched to Landscape' : 'Switched to Portrait';
    if (rotateDimTag) rotateDimTag.textContent = `${width}×${height}`;
    rotateOverlay1.classList.add('visible');
    rotateOverlayTimer = setTimeout(() => {
      rotateOverlay1.classList.remove('visible');
      rotateOverlayTimer = null;
    }, 1200);
  }
}

// ── Popout status ────────────────────────────────────────────────────────
window.mirrorLink.onPopoutStatus(({ isPoppedOut }) => {
  detachButton.textContent = isPoppedOut ? '⧉ Focus Detached Window' : '⧉ Detach Window';
});

// ── Buttons ──────────────────────────────────────────────────────────────
connectButton.onclick = async () => {
  connectButton.classList.add('hidden');
  disconnectButton.classList.remove('hidden');
  const ok = await setupDecoder();
  if (!ok) {
    connectButton.classList.remove('hidden');
    disconnectButton.classList.add('hidden');
    return;
  }
  const result = await window.mirrorLink.connect({
    maxEdge: resolutionSelect.value === 'auto' ? 0 : Number(resolutionSelect.value),
    fps: fpsSelect.value === 'auto' ? 0 : Number(fpsSelect.value)
  });
  if (!result.ok) {
    connectButton.classList.remove('hidden');
    disconnectButton.classList.add('hidden');
  }
};

disconnectButton.onclick = async () => {
  await window.mirrorLink.disconnect();
  if (decoder) {
    try { decoder.close(); } catch (_) {}
    decoder = null;
    decoderReady = false;
  }
};

detachButton.onclick = () => window.mirrorLink.openPopout();