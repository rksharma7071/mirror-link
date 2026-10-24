const canvas = document.getElementById('popoutCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const statusText = document.getElementById('status');
const resBadge = document.getElementById('resBadge');
const fpsDisplay = document.getElementById('fpsDisplay');
const btnDock = document.getElementById('btnDock');
const btnFullscreen = document.getElementById('btnFullscreen');

let decoder = null;
let decoderCodec = null;
let decoderReady = false;
let frameCounter = 0;
let lastFpsUpdateTime = performance.now();
let nextTimestampUs = 0;

function getTimestamp() {
  const now = Math.round(performance.now() * 1000);
  nextTimestampUs = Math.max(nextTimestampUs + 1, now);
  return nextTimestampUs;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(data);
}

async function setupDecoder() {
  const candidates = ['avc1.64002a', 'avc1.640028', 'avc1.4D4028', 'avc1.42E01E'];
  for (const codec of candidates) {
    try {
      const support = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
      if (support.supported) { decoderCodec = codec; break; }
    } catch (_) { }
  }
  if (!decoderCodec) { statusText.textContent = 'No H.264 decoder available'; return; }

  decoder = new VideoDecoder({
    output(frame) {
      try {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frameCounter++;
        const now = performance.now();
        if (now - lastFpsUpdateTime >= 1000) {
          fpsDisplay.textContent = `${Math.round(frameCounter * 1000 / (now - lastFpsUpdateTime))} FPS • Live`;
          frameCounter = 0;
          lastFpsUpdateTime = now;
        }
      } finally {
        frame.close();
        window.mirrorLink.ackFrame();
      }
    },
    error(e) {
      console.error('Popout decoder error:', e);
      if (decoder && decoderCodec) {
        try { decoder.configure({ codec: decoderCodec, optimizeForLatency: true }); } catch (_) {}
      }
      window.mirrorLink.ackFrame();
    }
  });
  decoder.configure({ codec: decoderCodec, optimizeForLatency: true });
  decoderReady = true;
}

setupDecoder();

window.mirrorLink.onStatus(({ state, message }) => { statusText.textContent = message; });

window.mirrorLink.onVideoSize(({ width, height }) => {
  resBadge.textContent = `${width}×${height}`;
  resBadge.classList.remove('hidden');
});

window.mirrorLink.onNal(({ data, isKey }) => {
  if (!decoder || !decoderReady) { window.mirrorLink.ackFrame(); return; }
  if (decoder.decodeQueueSize > 8 && !isKey) { window.mirrorLink.ackFrame(); return; }
  try {
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: getTimestamp(),
      data: toUint8(data)
    }));
  } catch (err) { console.error(err); }
  window.mirrorLink.ackFrame();
});

btnDock.addEventListener('click', () => window.mirrorLink.closePopout());
btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
});