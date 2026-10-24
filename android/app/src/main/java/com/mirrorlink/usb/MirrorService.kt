package com.mirrorlink.usb

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Surface
import android.view.WindowManager
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class MirrorService : Service() {
    companion object {
        const val TAG = "MirrorService"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val PORT = 27183
        private const val PROTOCOL_VERSION = 2
        private const val FPS = 60
        private const val MAX_LONG_EDGE = 1920
        private const val BITRATE_BPS = 8_000_000
        private const val MAX_BITRATE_BPS = 12_000_000
        private const val SEND_QUEUE_CAPACITY = 8
    }

    private val running = AtomicBoolean(false)
    private val captureLock = Any()
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var displayListener: DisplayManager.DisplayListener? = null
    @Volatile private var server: ServerSocket? = null
    private var drainThread: Thread? = null
    private var writerThread: Thread? = null
    private var width = 0
    private var height = 0
    private var captureDpi = 0

    // ---- client sink ----
    private val sinkLock = Any()
    @Volatile private var clientSocket: Socket? = null
    private var sink: DataOutputStream? = null

    // ---- bounded send queue (drop-oldest under pressure) ----
    private class OutFrame(val data: ByteArray, val isKey: Boolean)
    private val sendQueue = ArrayBlockingQueue<OutFrame>(SEND_QUEUE_CAPACITY)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this, 7, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        )
        if (!running.compareAndSet(false, true)) return START_NOT_STICKY

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val resultData = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_RESULT_DATA, Intent::class.java) }
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startCapture(resultCode, resultData)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start capture", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun align16(v: Float) = max(16, (v / 16f).roundToInt() * 16)

    private fun startCapture(resultCode: Int, resultData: Intent) {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(dm)
        val (captureWidth, captureHeight, dpi) = captureSize(dm)
        width = captureWidth
        height = captureHeight
        captureDpi = dpi
        val (newCodec, newSurface) = createEncoder(width, height)
        codec = newCodec
        inputSurface = newSurface

        val pm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = pm.getMediaProjection(resultCode, resultData)
        projectionCallback = object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "MediaProjection stopped")
                stopSelf()
            }
        }
        projection!!.registerCallback(projectionCallback!!, Handler(Looper.getMainLooper()))
        virtualDisplay = projection!!.createVirtualDisplay(
            "MirrorLink", width, height, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, inputSurface, null, null
        )

        drainThread = thread(name = "mirror-encoder") { drainEncoder(newCodec) }
        writerThread = thread(name = "mirror-writer") { writerLoop() }
        thread(name = "mirror-accept") { acceptLoop() }

        val displayManager = getSystemService(DisplayManager::class.java)
        displayListener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) {
                if (displayId == android.view.Display.DEFAULT_DISPLAY) handleDisplayRotation()
            }
        }.also { displayManager.registerDisplayListener(it, Handler(Looper.getMainLooper())) }
    }

    private fun captureSize(dm: DisplayMetrics): Triple<Int, Int, Int> {
        val scale = min(1f, MAX_LONG_EDGE.toFloat() / max(dm.widthPixels, dm.heightPixels))
        val captureWidth = align16(dm.widthPixels * scale)
        val captureHeight = align16(dm.heightPixels * scale)
        val dpi = (dm.densityDpi * scale).roundToInt().coerceAtLeast(72)
        return Triple(captureWidth, captureHeight, dpi)
    }

    private fun createEncoder(width: Int, height: Int): Pair<MediaCodec, Surface> {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, BITRATE_BPS)
            setInteger(MediaFormat.KEY_MAX_BIT_RATE, MAX_BITRATE_BPS)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
            setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
            setInteger(MediaFormat.KEY_MAX_FPS_TO_ENCODER, FPS)
            setInteger(MediaFormat.KEY_OPERATING_RATE, FPS)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // Embed SPS/PPS in every IDR — removes the need for the desktop-side SPS cache / resend hack.
            setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
            setInteger(MediaFormat.KEY_LATENCY, 0)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            }
        }

        try {
            val highFormat = MediaFormat(format).apply {
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
                setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel42)
            }
            val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            created.configure(highFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface = created.createInputSurface()
            created.start()
            Log.i(TAG, "Configured encoder: High profile, CBR ${BITRATE_BPS / 1_000_000} Mbps, ${FPS} FPS")
            return created to surface
        } catch (e: Exception) {
            Log.w(TAG, "High profile not supported, using Baseline profile", e)
            format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            format.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
            val created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface = created.createInputSurface()
            created.start()
            return created to surface
        }
    }

    private fun handleDisplayRotation() {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(dm)
        val (nextWidth, nextHeight, nextDpi) = captureSize(dm)
        if (nextWidth == width && nextHeight == height && nextDpi == captureDpi) return

        thread(name = "mirror-resize") {
            synchronized(captureLock) {
                if (!running.get() || (nextWidth == width && nextHeight == height && nextDpi == captureDpi)) return@synchronized
                Log.i(TAG, "Display changed to ${nextWidth}x${nextHeight}; rebuilding encoder")
                virtualDisplay?.setSurface(null)
                val oldCodec = codec
                codec = null
                // Encoder drain exits quickly now — it just enqueues, no blocking writes.
                try { drainThread?.join(1500) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
                try { oldCodec?.stop() } catch (_: Exception) {}
                try { oldCodec?.release() } catch (_: Exception) {}
                try { inputSurface?.release() } catch (_: Exception) {}

                width = nextWidth
                height = nextHeight
                captureDpi = nextDpi
                // Purge stale frames before the new resolution takes effect.
                sendQueue.clear()
                val (newCodec, newSurface) = createEncoder(width, height)
                codec = newCodec
                inputSurface = newSurface
                virtualDisplay?.resize(width, height, captureDpi)
                virtualDisplay?.setSurface(newSurface)
                sendResolutionChange(width, height)
                drainThread = thread(name = "mirror-encoder") { drainEncoder(newCodec) }
            }
        }
    }

    /** Drains the encoder output queue and enqueues frames for the writer thread. */
    private fun drainEncoder(c: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        var frameCount = 0L
        try {
            while (running.get() && codec === c) {
                val index = c.dequeueOutputBuffer(info, 2_000)
                if (index < 0) continue
                try {
                    val buf = c.getOutputBuffer(index)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val bytes = ByteArray(info.size).also { buf.get(it) }
                        val isKey = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                        // PREPEND_HEADER embeds SPS/PPS in every IDR, so we forward everything as-is.
                        enqueueFrame(bytes, isKey)
                        frameCount++
                        if (frameCount % 200 == 0L) Log.d(TAG, "Enqueued $frameCount frames")
                    }
                } finally {
                    c.releaseOutputBuffer(index, false)
                }
            }
        } catch (e: Exception) {
            if (running.get()) Log.e(TAG, "Encoder loop failed", e)
        }
    }

    private fun enqueueFrame(data: ByteArray, isKey: Boolean) {
        if (!sendQueue.offer(OutFrame(data, isKey))) {
            // Queue full: purge and request a fresh keyframe so the client recovers cleanly.
            Log.w(TAG, "Send queue full; dropping ${sendQueue.size} frames")
            sendQueue.clear()
            requestKeyframe()
            if (isKey) sendQueue.offer(OutFrame(data, true))
        }
    }

    private fun writerLoop() {
        while (running.get()) {
            val frame = try {
                sendQueue.poll(100, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                continue
            } ?: continue
            synchronized(sinkLock) {
                val out = sink ?: return@synchronized
                try {
                    out.writeInt(frame.data.size)
                    out.write(frame.data)
                    out.flush()
                } catch (e: IOException) {
                    Log.i(TAG, "Client write failed: ${e.message}")
                    closeClientLocked()
                }
            }
        }
    }

    private fun requestKeyframe() {
        try {
            codec?.setParameters(Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            })
        } catch (e: Exception) {
            Log.w(TAG, "requestKeyframe failed", e)
        }
    }

    private fun sendResolutionChange(width: Int, height: Int) {
        // Purge any frames from the old resolution before the size update.
        sendQueue.clear()
        synchronized(sinkLock) {
            val out = sink ?: return
            try {
                out.writeInt(0) // zero-length packet == v2 resolution update
                out.writeInt(width)
                out.writeInt(height)
                out.writeInt(FPS)
                out.flush()
            } catch (e: IOException) {
                Log.i(TAG, "Failed to send resolution update: ${e.message}")
                closeClientLocked()
            }
        }
    }

    private fun closeClientLocked() {
        try { sink?.close() } catch (_: Exception) {}
        try { clientSocket?.close() } catch (_: Exception) {}
        sink = null
        clientSocket = null
    }

    private fun acceptLoop() {
        val srv = try {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(PORT), 1)
            }
        } catch (e: Exception) {
            Log.e(TAG, "ServerSocket failed: ${e.message}", e)
            stopSelf()
            return
        }
        server = srv
        Log.i(TAG, "Listening on port $PORT")
        try {
            while (running.get()) {
                val socket = try { srv.accept() } catch (e: IOException) { break }
                if (!socket.inetAddress.isLoopbackAddress) {
                    Log.w(TAG, "Rejecting non-loopback connection from ${socket.inetAddress}")
                    socket.close()
                    continue
                }
                try { attachClient(socket) }
                catch (e: Exception) {
                    Log.w(TAG, "Failed to attach client: ${e.message}")
                    try { socket.close() } catch (_: Exception) {}
                }
            }
        } finally {
            try { srv.close() } catch (_: Exception) {}
        }
    }

    private fun attachClient(socket: Socket) {
        socket.tcpNoDelay = true
        // Drop frames buffered for the previous client — they belong to a different session.
        sendQueue.clear()
        synchronized(sinkLock) {
            closeClientLocked()
            val out = DataOutputStream(socket.getOutputStream())
            out.write("MLNK".toByteArray(Charsets.US_ASCII))
            out.writeInt(PROTOCOL_VERSION)
            out.writeInt(width)
            out.writeInt(height)
            out.writeInt(FPS)
            out.flush()
            clientSocket = socket
            sink = out
        }
        Log.i(TAG, "Desktop connected from ${socket.remoteSocketAddress}")
        requestKeyframe()
    }

    private fun notification(): Notification {
        val channel = NotificationChannel("mirror", "Screen sharing", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        return Notification.Builder(this, "mirror")
            .setContentTitle("MirrorLink USB is sharing your screen")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        Log.i(TAG, "MirrorService onDestroy")
        running.set(false)
        displayListener?.let {
            try { getSystemService(DisplayManager::class.java).unregisterDisplayListener(it) } catch (_: Exception) {}
        }
        try { server?.close() } catch (_: Exception) {}
        synchronized(sinkLock) { closeClientLocked() }
        try { drainThread?.join(500) } catch (_: InterruptedException) {}
        try { writerThread?.join(500) } catch (_: InterruptedException) {}
        projectionCallback?.let { try { projection?.unregisterCallback(it) } catch (_: Exception) {} }
        try { virtualDisplay?.release() } catch (_: Exception) {}
        try { codec?.stop() } catch (_: Exception) {}
        try { codec?.release() } catch (_: Exception) {}
        try { inputSurface?.release() } catch (_: Exception) {}
        try { projection?.stop() } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}