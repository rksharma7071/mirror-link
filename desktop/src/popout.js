const canvas = document.getElementById('popoutCanvas');
const statusText = document.getElementById('status');
const resBadge = document.getElementById('resBadge');
const fpsDisplay = document.getElementById('fpsDisplay');
const btnDock = document.getElementById('btnDock');
const btnFullscreen = document.getElementById('btnFullscreen');

let context = null;
let videoWidth = 0;
let videoHeight = 0;

let pendingFrame = null;
let animRequested = false;
let animTimeout = null;
let renderTicket = 0;

let frameCounter = 0;
let lastFpsUpdateTime = performance.now();

window.mirrorLink.onStatus(message => {
  statusText.textContent = message;
});

window.mirrorLink.onVideoSize(({ width, height }) => {
  videoWidth = width;
  videoHeight = height;
  canvas.width = width;
  canvas.height = height;
  context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (context) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
  }
  resBadge.textContent = `${width}×${height}`;
  resBadge.classList.remove('hidden');
});

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
    if (!context) {
      context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (context) {
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
      }
    }
    if (context) {
      const pixels = new Uint8ClampedArray(
        pendingFrame.buffer,
        pendingFrame.byteOffset,
        pendingFrame.byteLength
      );
      const imgData = new ImageData(pixels, videoWidth, videoHeight);
      context.putImageData(imgData, 0, 0);

      // FPS tracking
      frameCounter++;
      const now = performance.now();
      if (now - lastFpsUpdateTime >= 1000) {
        const fps = Math.round((frameCounter * 1000) / (now - lastFpsUpdateTime));
        fpsDisplay.textContent = `${fps} FPS • Live`;
        frameCounter = 0;
        lastFpsUpdateTime = now;
      }
    }
  } catch (err) {
    console.error('Popout render error:', err);
  } finally {
    pendingFrame = null;
    window.mirrorLink.ackFrame();
  }
}

window.mirrorLink.onFrame(frame => {
  pendingFrame = frame;
  if (!animRequested) {
    animRequested = true;
    const ticket = ++renderTicket;
    requestAnimationFrame(() => renderNextFrame(ticket));
    animTimeout = setTimeout(() => renderNextFrame(ticket), 35);
  }
});

btnDock.addEventListener('click', () => {
  window.mirrorLink.closePopout();
});

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});
