# Screen Share Streaming

## Architecture

The screen-share flow now uses an explicit LiveKit pipeline in `components/voice-room.tsx`:

- `startLocalScreenShare(...)` calls `room.localParticipant.createScreenTracks(...)`
- the created video track is published with screen-share-specific `TrackPublishOptions`
- optional system audio is published separately with explicit audio publish settings
- the published video sender is tuned with `getParameters()` / `setParameters()`
- `stopLocalScreenShare(...)` unpublishes and stops the active local share tracks
- focused remote screen-share publications are explicitly subscribed at `VideoQuality.HIGH`

Electron source selection still runs through `electron/main.cjs`, but it only selects the source and does not force low-resolution capture.

Omarchy's Wayland/PipeWire path must enumerate capture sources exactly once per attempt. Each PipeWire enumeration can create a new portal session with a new source ID, so the main process retains the trusted `DesktopCapturerSource` returned for the picker and grants that exact source to `getDisplayMedia`. It never re-enumerates or reclassifies the selected source. Stale results from closed or overlapping portal requests are discarded in both processes. The retained source is one-shot, expires after 15 seconds once prepared, and is cleared when the picker closes or capture finishes.

The renderer completes the stream-usage preflight before preparing the source. This keeps a slow API response from consuming the main process's 15-second prepared-source window.

## Audio

Electron's loopback display-audio grant is Windows-only. The Omarchy desktop client therefore disables the system-audio option and always requests video-only capture; this avoids rejecting an otherwise valid PipeWire stream.

When a supported browser capture supplies system audio, LiveKit/WebRTC publishes it with Opus. SovChat makes the Opus path explicit instead of relying only on SDK defaults:

- microphone tracks publish with the `AudioPresets.music` Opus bitrate cap, mono audio, DTX enabled, and Opus RED enabled
- screen-share system audio publishes separately with `AudioPresets.musicHighQualityStereo`, stereo enabled, Opus RED enabled, and DTX disabled for continuous game/system audio
- the voice room stores local sender audio samples in `window.__sovchatAudioStats` and logs them as `[voice:audio]`, including the negotiated codec when WebRTC stats expose it
- the local mic analyser watches for sustained broadband noise and recreates the microphone track once per cooldown when it looks like a device/driver white-noise fault

## Presets

Tunable presets live in `STREAM_QUALITY_PROFILES`:

- `auto`: VP8, 1280x720 at 60 fps, `contentHint: "motion"`, 6 Mbps cap
- `720p`: VP8, 1280x720 at 60 fps, `contentHint: "motion"`, 6 Mbps cap
- `1080p`: VP8, 1920x1080 at 60 fps, `contentHint: "motion"`, 12 Mbps cap
- `1440p`: VP8, 2560x1440 at 60 fps, `contentHint: "motion"`, 18 Mbps cap

Tune these fields if you want to push quality further:

- `capture.resolution`
- `capture.contentHint`
- `videoPublish.screenShareEncoding`
- `videoPublish.screenShareSimulcastLayers`
- `videoPublish.videoCodec`
- `sender.maxBitrate`
- `sender.maxFramerate`

The resolution presets intentionally use `vp8`. H264 is kept as a fallback when VP8 publish fails.

## Diagnostics

The voice room now renders a temporary diagnostics panel showing:

- room `adaptiveStream` / `dynacast`
- captured width / height / frame rate
- chosen content hint
- chosen publish options
- tuned sender parameters
- focused receiver subscription state and requested quality
- actual attached video render FPS, which helps separate capture/encode issues from viewer-side rendering

When stream diagnostics are enabled, it writes the same object to `console.info("[voice:stream]", ...)`.

## Commands

Install dependencies:

```bash
npm install
```

Run the web app:

```bash
npm run dev:web
```

Run the Electron desktop shell:

```bash
npm run dev:desktop
```
