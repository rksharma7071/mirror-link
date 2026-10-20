# MirrorLink USB

MirrorLink USB is an Android-to-desktop screen mirroring project. It works on a USB cable through Android Debug Bridge (ADB), so the phone and computer do not need to be on the same Wi-Fi network.

## What is included

- `android/` — an Android app that asks for the system screen-capture permission and sends H.264 video over a local TCP socket.
- `desktop/` — an Electron receiver that discovers an attached Android device, creates an ADB port forward, decodes the stream with FFmpeg, and renders it to a canvas. Electron packages for Windows and macOS use the same source.

## Prerequisites

1. Enable **Developer options** and **USB debugging** on the Android phone.
2. Install Android Platform Tools (`adb`) on the desktop computer.
3. Install FFmpeg on the desktop computer, or bundle its executable when producing the installers.
4. Build and install the Android application. The desktop receiver needs a signed build for release distribution.

## Run during development

Build the Android app with Android Studio or `./gradlew assembleDebug` from `android/`, then install it on the phone. On the desktop:

```sh
cd desktop
npm install
npm run dev
```

Connect the phone by USB, authorize its debugging prompt, open MirrorLink USB on the phone and tap **Start sharing**. Then choose **Connect by USB** in the desktop app.

## Wire protocol

The phone exposes a TCP server only on `127.0.0.1:27183`. The desktop maps that socket with:

```sh
adb forward tcp:27183 tcp:27183
```

The stream begins with a 20-byte big-endian header:

| Bytes | Value |
| --- | --- |
| 0–3 | `MLNK` magic |
| 4–7 | protocol version (`1`) |
| 8–11 | video width |
| 12–15 | video height |
| 16–19 | frame rate |

Each subsequent H.264 access unit is prefixed by a four-byte big-endian payload length. The desktop removes that prefix before writing bytes to FFmpeg.

## Release notes

The APK can only mirror Android devices. Each capture session requires Android's standard user approval. This project is deliberately view-only: it does not add remote control, recording, audio capture, or bypass operating-system permission dialogs.

For production, sign the APK; code-sign/notarize the macOS package; code-sign the Windows installer; and bundle architecture-specific `adb` and `ffmpeg` binaries.
