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
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
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
        private const val FPS = 30
        private const val MAX_LONG_EDGE = 1280
    }

    private val running = AtomicBoolean(false)
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var virtualDisplay: VirtualDisplay? = null
    @Volatile private var server: ServerSocket? = null
    private var drainThread: Thread? = null
    private var width = 0
    private var height = 0

    private val sinkLock = Any()
    @Volatile private var clientSocket: Socket? = null
    private var sink: DataOutputStream? = null
    @Volatile private var codecConfig: ByteArray? = null

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
        val scale = min(1f, MAX_LONG_EDGE.toFloat() / max(dm.widthPixels, dm.heightPixels))
        width = align16(dm.widthPixels * scale)
        height = align16(dm.heightPixels * scale)
        val dpi = (dm.densityDpi * scale).roundToInt().coerceAtLeast(72)

        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 5_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            setInteger(MediaFormat.KEY_LATENCY, 0)
            setInteger(MediaFormat.KEY_PRIORITY, 0)
            setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
            setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
        }

        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
            configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = createInputSurface()
            start()
        }

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

        drainThread = thread(name = "mirror-encoder") { drainEncoder() }
        thread(name = "mirror-accept") { acceptLoop() }
    }

    /** Always drains the encoder, continuously sending frames to the connected client. */
    private fun drainEncoder() {
        val c = codec ?: return
        val info = MediaCodec.BufferInfo()
        var frameCount = 0L
        var lastSyncRequest = System.currentTimeMillis()
        try {
            while (running.get()) {
                val now = System.currentTimeMillis()
                if (now - lastSyncRequest > 2000L) {
                    lastSyncRequest = now
                    try {
                        c.setParameters(Bundle().apply {
                            putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
                        })
                    } catch (_: Exception) {}
                }

                val index = c.dequeueOutputBuffer(info, 10_000)
                if (index < 0) continue
                try {
                    val buf = c.getOutputBuffer(index)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val bytes = ByteArray(info.size).also { buf.get(it) }
                        if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            Log.i(TAG, "Captured SPS/PPS config (${bytes.size} bytes)")
                            codecConfig = bytes
                        }
                        val isKeyFrame = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                        if (isKeyFrame && codecConfig != null) {
                            sendToClient(codecConfig!!)
                        }
                        sendToClient(bytes)
                        frameCount++
                        if (frameCount % 100 == 0L) {
                            Log.d(TAG, "Sent $frameCount frames to client")
                        }
                    }
                } finally {
                    c.releaseOutputBuffer(index, false)
                }
            }
        } catch (e: Exception) {
            if (running.get()) Log.e(TAG, "Encoder loop failed", e)
        }
    }

    private fun sendToClient(bytes: ByteArray) {
        synchronized(sinkLock) {
            val out = sink ?: return
            try {
                out.writeInt(bytes.size)
                out.write(bytes)
                out.flush()
            } catch (e: IOException) {
                Log.i(TAG, "Client write failed: ${e.message}")
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
                try {
                    attachClient(socket)
                } catch (e: Exception) {
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
        clientSocket?.let { try { it.close() } catch (_: Exception) {} }
        synchronized(sinkLock) {
            closeClientLocked()
            val out = DataOutputStream(BufferedOutputStream(socket.getOutputStream(), 64 * 1024))
            out.write("MLNK".toByteArray(Charsets.US_ASCII))
            out.writeInt(1)
            out.writeInt(width)
            out.writeInt(height)
            out.writeInt(FPS)
            codecConfig?.let {
                Log.i(TAG, "Sending SPS/PPS config to newly connected client (${it.size} bytes)")
                out.writeInt(it.size)
                out.write(it)
            }
            out.flush()
            clientSocket = socket
            sink = out
        }
        Log.i(TAG, "Desktop connected from ${socket.remoteSocketAddress}")
        try {
            codec?.setParameters(Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
            })
        } catch (e: Exception) {
            Log.w(TAG, "Failed to request sync frame", e)
        }
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
        try { server?.close() } catch (_: Exception) {}
        synchronized(sinkLock) { closeClientLocked() }
        try { drainThread?.join(500) } catch (_: InterruptedException) {}
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