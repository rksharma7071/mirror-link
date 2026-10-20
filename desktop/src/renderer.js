const status = document.getElementById('status');
const canvas = document.getElementById('screen');
let context = null;
let pendingFrame = null;
let animRequested = false;

window.mirrorLink.onStatus(message => {
  status.textContent = message;
});

window.mirrorLink.onVideoSize(({ width, height }) => {
  canvas.width = width;
  canvas.height = height;
  context = canvas.getContext('2d');
});

function renderNextFrame() {
  animRequested = false;
  if (pendingFrame) {
    if (!context && canvas.width && canvas.height) {
      context = canvas.getContext('2d');
    }
    if (context && canvas.width && canvas.height) {
      try {
        const pixels = new Uint8ClampedArray(
          pendingFrame.buffer,
          pendingFrame.byteOffset,
          pendingFrame.byteLength
        );
        context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      } catch (err) {
        console.error('Frame render failed:', err);
      }
    }
    pendingFrame = null;
  }
}

window.mirrorLink.onFrame(frame => {
  pendingFrame = frame;
  if (!animRequested) {
    animRequested = true;
    requestAnimationFrame(renderNextFrame);
  }
  if (typeof window.mirrorLink.ackFrame === 'function') {
    window.mirrorLink.ackFrame();
  }
});

document.getElementById('connect').onclick = () => window.mirrorLink.connect();
document.getElementById('disconnect').onclick = () => window.mirrorLink.disconnect();