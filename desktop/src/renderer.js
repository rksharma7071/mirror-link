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
const orientBadge1   = document.getElementById('orientBadge1');
const orientBadgeText = document.getElementById('orientBadgeText');
const rotateOverlay1 = document.getElementById('rotateOverlay1');
const rotateIcon1    = document.getElementById('rotateIcon1');
const rotateLabel1   = document.getElementById('rotateLabelText');
const rotateDimTag   = document.getElementById('rotateDimTag');

// ── SVG templates for each orientation transition ───────────────────────────
const SVG_TO_LANDSCAPE = `
<svg class="orient-svg" width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Portrait phone (source) -->
  <rect x="16" y="6" width="18" height="30" rx="3"
        fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="22" y1="33" x2="28" y2="33"
        stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Curved arc arrow: portrait → landscape -->
  <path d="M 38 16 C 50 10 62 20 58 36"
        fill="none" stroke="#3fb950" stroke-width="2.2" stroke-linecap="round"
        stroke-dasharray="3 2"/>
  <!-- Arrowhead -->
  <polygon points="55,40 63,33 62,42" fill="#3fb950"/>
  <!-- Landscape phone (destination, slightly faded) -->
  <rect x="38" y="36" width="26" height="15" rx="3"
        fill="none" stroke="#3fb950" stroke-width="2.2" stroke-linejoin="round" opacity="0.75"/>
  <line x1="56" y1="40" x2="56" y2="47"
        stroke="#3fb950" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
</svg>`;

const SVG_TO_PORTRAIT = `
<svg class="orient-svg" width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Landscape phone (source) -->
  <rect x="8" y="28" width="26" height="15" rx="3"
        fill="none" stroke="#3fb950" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="27" y1="32" x2="27" y2="39"
        stroke="#3fb950" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Curved arc arrow: landscape → portrait -->
  <path d="M 36 28 C 46 18 58 24 56 12"
        fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round"
        stroke-dasharray="3 2"/>
  <!-- Arrowhead -->
  <polygon points="52,8 60,14 53,18" fill="#58a6ff"/>
  <!-- Portrait phone (destination, slightly faded) -->
  <rect x="42" y="6" width="18" height="30" rx="3"
        fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linejoin="round" opacity="0.75"/>
  <line x1="48" y1="33" x2="54" y2="33"
        stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round" opacity="0.75"/>
</svg>`;

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
    // Only update the text span, preserving the SVG icon inside the badge
    if (orientBadgeText) orientBadgeText.textContent = isLandscape ? 'Landscape' : 'Portrait';
    orientBadge1.classList.toggle('landscape', isLandscape);
  }

  // Show rotation overlay only when orientation actually changes (not on first connect)
  if (changed && rotateOverlay1) {
    // Reset any pending hide timer
    if (rotateOverlayTimer) clearTimeout(rotateOverlayTimer);

    // Inject the correct SVG icon for the transition direction
    if (rotateIcon1) {
      rotateIcon1.innerHTML = isLandscape ? SVG_TO_LANDSCAPE : SVG_TO_PORTRAIT;
      // Re-trigger CSS entrance animation
      const svg = rotateIcon1.querySelector('svg');
      if (svg) {
        svg.style.animation = 'none';
        void svg.offsetWidth; // force reflow
        svg.style.animation = '';
      }
    }

    // Update label text and dimension tag
    if (rotateLabel1) {
      rotateLabel1.textContent = isLandscape ? 'Switched to Landscape' : 'Switched to Portrait';
    }
    if (rotateDimTag) {
      rotateDimTag.textContent = `${width}×${height}`;
    }

    rotateOverlay1.classList.add('visible');
    // Auto-hide after 1200 ms
    rotateOverlayTimer = setTimeout(() => {
      rotateOverlay1.classList.remove('visible');
      rotateOverlayTimer = null;
    }, 1200);
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
