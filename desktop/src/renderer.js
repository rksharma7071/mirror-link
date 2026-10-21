const statusText = document.getElementById('status');
const statusDot = document.getElementById('statusDot');
const resBadge = document.getElementById('resBadge');
const fpsDisplay = document.getElementById('fpsDisplay');
const streamStats = document.getElementById('streamStats');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const resolutionSelect = document.getElementById('resolutionSelect');
const fpsSelect = document.getElementById('fpsSelect');

for (const [key, select] of [['mirrorlink-resolution', resolutionSelect], ['mirrorlink-fps', fpsSelect]]) {
  const saved = localStorage.getItem(key);
  if (saved && [...select.options].some(option => option.value === saved)) select.value = saved;
  select.addEventListener('change', () => localStorage.setItem(key, select.value));
}

const canvas1 = document.getElementById('screen1');
const canvas2 = document.getElementById('screen2');
const pane1 = document.getElementById('pane1');
const pane2 = document.getElementById('pane2');
const pane2Detached = document.getElementById('pane2Detached');
const btnDockBack = document.getElementById('btnDockBack');
const btnFocusPopout = document.getElementById('btnFocusPopout');
const orientBadge1 = document.getElementById('orientBadge1');
const rotateOverlay1 = document.getElementById('rotateOverlay1');
const rotateIcon1 = document.getElementById('rotateIcon1');
const rotateLabel1 = document.getElementById('rotateLabel1');

let context1 = null;
let context2 = null;
let videoWidth = 0;
let videoHeight = 0;

// Track current orientation to detect changes
let currentOrientation = null; // 'portrait' | 'landscape'

let isTab2PoppedOut = false;

let pendingFrame = null;
let animRequested = false;
let animTimeout = null;
let renderTicket = 0;

// FPS tracking
let frameCounter = 0;
let lastFpsUpdateTime = performance.now();

// Status listener
window.mirrorLink.onStatus(message => {
  statusText.textContent = message;
  if (message.includes('Streaming') || message.includes('Live')) {
    setConnectionButtons(true);
    statusDot.className = 'status-dot active';
    streamStats.classList.remove('hidden');
  } else if (message.includes('Disconnected')) {
    setConnectionButtons(false);
    statusDot.className = 'status-dot';
    streamStats.classList.add('hidden');
  } else if (message.includes('error') || message.includes('failed') || message.includes('not found')) {
    setConnectionButtons(false);
    statusDot.className = 'status-dot error';
  } else if (message.includes('stopped sharing') || message.includes('Connection closed')) {
    setConnectionButtons(false);
    statusDot.className = 'status-dot';
    streamStats.classList.add('hidden');
  } else {
    statusDot.className = 'status-dot';
  }
});

function setConnectionButtons(connected) {
  connectButton.classList.toggle('hidden', connected);
  disconnectButton.classList.toggle('hidden', !connected);
}

// ── Adaptive Orientation ────────────────────────────────────────────────────
let rotateOverlayTimer = null;

/**
 * Determine orientation from video dimensions and update the pane layout,
 * orientation badge, and show a brief animated overlay when it changes.
 */
function applyOrientation(width, height) {
  const newOrientation = width >= height ? 'landscape' : 'portrait';
  const changed = newOrientation !== currentOrientation;
  currentOrientation = newOrientation;

  const isLandscape = newOrientation === 'landscape';

  // Update pane CSS classes for adaptive sizing
  pane1.classList.toggle('orient-landscape', isLandscape);
  pane1.classList.toggle('orient-portrait', !isLandscape);

  // Update orientation badge
  if (orientBadge1) {
    orientBadge1.textContent = isLandscape ? 'Landscape' : 'Portrait';
    orientBadge1.classList.toggle('landscape', isLandscape);
  }

  // Show rotation overlay only when orientation actually changes (not on first connect)
  if (changed && rotateOverlay1) {
    // Reset any pending hide timer
    if (rotateOverlayTimer) clearTimeout(rotateOverlayTimer);

    // Update icon and label
    if (rotateIcon1) {
      // Use a rotation arrow to signal the change direction
      rotateIcon1.textContent = isLandscape ? '🔄' : '🔄';
      // Re-trigger the CSS keyframe by removing & re-adding the element's animation
      rotateIcon1.style.animation = 'none';
      void rotateIcon1.offsetWidth; // force reflow
      rotateIcon1.style.animation = '';
    }
    if (rotateLabel1) {
      rotateLabel1.textContent = isLandscape
        ? `Landscape  ${width}×${height}`
        : `Portrait  ${width}×${height}`;
    }

    rotateOverlay1.classList.add('visible');
    // Auto-hide after 900 ms
    rotateOverlayTimer = setTimeout(() => {
      rotateOverlay1.classList.remove('visible');
      rotateOverlayTimer = null;
    }, 900);
  }
}

// ── Video size listener ──────────────────────────────────────────────────────
window.mirrorLink.onVideoSize(({ width, height, fps }) => {
  videoWidth = width;
  videoHeight = height;

  canvas1.width = width;
  canvas1.height = height;
  context1 = canvas1.getContext('2d', { alpha: false, desynchronized: true });
  if (context1) {
    context1.imageSmoothingEnabled = true;
    context1.imageSmoothingQuality = 'high';
  }

  canvas2.width = width;
  canvas2.height = height;
  context2 = canvas2.getContext('2d', { alpha: false, desynchronized: true });
  if (context2) {
    context2.imageSmoothingEnabled = true;
    context2.imageSmoothingQuality = 'high';
  }

  resBadge.textContent = `${width}×${height}`;
  resBadge.classList.remove('hidden');

  // Apply adaptive orientation layout
  applyOrientation(width, height);
});

// Popout status listener
window.mirrorLink.onPopoutStatus(({ isPoppedOut }) => {
  setTab2PoppedState(isPoppedOut);
});

function setTab2PoppedState(popped) {
  isTab2PoppedOut = popped;
  if (popped) {
    canvas2.classList.add('hidden');
    pane2Detached.classList.remove('hidden');
  } else {
    canvas2.classList.remove('hidden');
    pane2Detached.classList.add('hidden');
  }
}

// Check initial popout status
window.mirrorLink.getPopoutStatus?.().then(({ isPoppedOut }) => {
  setTab2PoppedState(isPoppedOut);
}).catch(() => {});

function updateLayout() {
  // Tab bar removed — pane1 is always visible, pane2 hidden unless actively used
  pane1.classList.remove('hidden');
  pane2.classList.add('hidden');
}

// Initialize layout on startup
updateLayout();

// Ultra-low latency frame rendering
function renderNextFrame(ticket) {
  if (!animRequested || ticket !== renderTicket) return;
  animRequested = false;
  renderTicket++;
  if (animTimeout) {
    clearTimeout(animTimeout);
    animTimeout = null;
  }

  if (!pendingFrame || !videoWidth || !videoHeight) {
    window.mirrorLink.ackFrame();
    return;
  }

  try {
    const pixels = new Uint8ClampedArray(
      pendingFrame.buffer,
      pendingFrame.byteOffset,
      pendingFrame.byteLength
    );
    const imgData = new ImageData(pixels, videoWidth, videoHeight);

    // Draw to Tab 1 if visible
    if (!pane1.classList.contains('hidden') && context1) {
      context1.putImageData(imgData, 0, 0);
    }

    // Draw to Tab 2 if visible and docked
    if (!pane2.classList.contains('hidden') && !isTab2PoppedOut && context2) {
      context2.putImageData(imgData, 0, 0);
    }

    // FPS calculation
    frameCounter++;
    const now = performance.now();
    if (now - lastFpsUpdateTime >= 1000) {
      const fps = Math.round((frameCounter * 1000) / (now - lastFpsUpdateTime));
      fpsDisplay.textContent = `${fps} FPS • Live`;
      frameCounter = 0;
      lastFpsUpdateTime = now;
    }
  } catch (err) {
    console.error('Frame render failed:', err);
  } finally {
    pendingFrame = null;
    // Immediately tell the main process we are ready for the next live frame!
    window.mirrorLink.ackFrame();
  }
}

window.mirrorLink.onFrame(frame => {
  pendingFrame = frame;
  if (!animRequested) {
    animRequested = true;
    const ticket = ++renderTicket;
    requestAnimationFrame(() => renderNextFrame(ticket));
    // Safety fallback in case requestAnimationFrame delays
    animTimeout = setTimeout(() => renderNextFrame(ticket), 35);
  }
});

connectButton.onclick = () => window.mirrorLink.connect({
  maxEdge: resolutionSelect.value === 'auto' ? 0 : Number(resolutionSelect.value),
  fps: fpsSelect.value === 'auto' ? 0 : Number(fpsSelect.value)
});
disconnectButton.onclick = () => window.mirrorLink.disconnect();
