# ForgeNotes Recorder (macOS)

Supports two recording setups. **Online call** captures your microphone and the call audio (the
other participants) as separate tracks. **In person / room** captures one room microphone and
tells ForgeNotes to separate speakers during transcription.

This repository is the macOS recorder. How it captures call audio depends on the version of
macOS, and it uses exactly one of the two ways for a recording:

| macOS | Call audio | What the user installs |
| --- | --- | --- |
| 14.2 and later (Sonoma 14.2+, Sequoia, 26, 27) | Recorded by macOS itself (a Core Audio tap) | Nothing. macOS asks for permission once. |
| 12.0 to 14.1 | The **BlackHole 2ch** virtual audio device | BlackHole 2ch, plus a Multi-Output Device |

Neither way records the screen, and the app never asks for the Screen Recording permission.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or 64-bit Intel Mac
- Node.js 24 for development and release builds
- BlackHole 2ch for capturing call audio, on macOS 12.0 to 14.1 only

## Installation

The distributed DMG is signed with a Developer ID Application certificate (team
`X36AQ2X3XN`) and notarized by Apple, so it opens normally: drag to Applications and
launch. No quarantine command, no right-click → Open. See
[INTERNAL_INSTALL.md](INTERNAL_INSTALL.md) for installation and verification steps.

Installed copies update themselves — see [Updates](#updates).

## Recording setups

Choose **In person / room** when one microphone is capturing everyone nearby. Call audio is not
recorded in this mode and nothing needs setting up for it. Put the microphone near the center of
the room and verify the live level meter before recording.

Choose **Online call** for Zoom, Meet, Discord, and similar calls. See
[Call audio](#call-audio) for the one-time step your version of macOS needs.

With **Announce recording aloud** on (the default), the app plays a recorded voice saying “This meeting
is being recorded.” once through the Mac's default audio output right after capture starts. Pick the
voice under the checkbox; **Preview** plays it. It is not injected into the call: remote participants
only hear it if your speakers are on. Resuming from pause does not repeat it.

The clips are pre-rendered files in `renderer/announce/` (made with Kokoro-82M, Apache-2.0), listed in
`renderer/announce/voices.json` together with the default voice. To change the voices, edit that file and
add or remove the matching `<id>.mp3`; `npm run verify` checks the list against the files. No system
speech voice is used.

## Call audio

The app shows the controls for the way your Mac uses and hides the other one's. The device check
at the top of the recorder says which it is and whether it is ready.

### macOS 14.2 and later: one permission, nothing to install

1. Choose **Online call**. Under **Device check**, the **Call audio** line says one step is left.
2. Click **Allow call audio**. macOS shows a window asking whether ForgeNotes Recorder may record
   this computer's audio. Choose **Allow**.
3. The **Call audio** line changes to **Ready**. That is all: no driver, no Audio MIDI Setup, and
   you keep hearing the call through whatever speakers or headphones you already use.

Nothing is recorded by this step. Call audio is only captured between **Start recording** and
**Stop & save**.

If you chose **Don't Allow**, or the line says macOS is not letting ForgeNotes record call audio:
open **System Settings → Privacy & Security → Screen & System Audio Recording**, and under
**System Audio Recording Only** turn on **ForgeNotes Recorder**. (The **Open System Settings**
button in the app goes straight there.) If macOS asks to quit and reopen the app, accept;
otherwise click **Re-check**.

During a recording the **Call audio** meter moves when anyone on the call speaks. The app tells
you while the meeting is still running if call audio is not arriving, and it reconnects by itself
when you switch speakers or headphones. Things to know:

- **Sound output.** macOS hands over what plays through the Mac's current sound output
  (**System Settings → Sound → Output**). A meeting app set to play through a different device
  than the Mac's output is not heard. In the meeting app's audio settings, leave the speaker on
  the system default (in Zoom: "Same as System").
- **Bluetooth headsets.** Using a Bluetooth headset's own microphone puts the headset into call
  mode: sound quality drops, and on some headsets the microphone or the call audio goes silent.
  The device check warns when the chosen microphone looks like one. The Mac's built-in
  microphone with the headset kept for listening records more reliably.
- **Laptop speakers.** Without headphones, the microphone also hears the call from the speakers,
  so the other participants are in both tracks. See [Echo](#echo-on-laptop-speakers).
- **The recording announcement** is played by the app through the Mac's sound output, so it is
  in the call-audio track as well.

To keep using BlackHole on a Mac that does not need it, set **Call audio capture** to
**BlackHole driver**. The app then uses only BlackHole.

### macOS 12.0 to 14.1: BlackHole

These versions of macOS cannot hand call audio to an app, so a virtual audio device carries it.
BlackHole is a separate, free product that you install yourself; it is not part of ForgeNotes
Recorder.

1. Install BlackHole:

   ```sh
   brew install blackhole-2ch
   ```

2. Open **Audio MIDI Setup** and create a **Multi-Output Device**.
3. Select both your normal speakers/headphones and **BlackHole 2ch**.
4. Set the Mac's sound output (or the meeting app's speaker) to that Multi-Output Device.
5. In the recorder, **System audio source** selects BlackHole 2ch automatically.

The recorder's **You** and **Call audio** meters confirm that both tracks are receiving audio. If
the sound output is switched away from the Multi-Output Device during a recording, call audio
stops arriving; the app says so.

### Echo on laptop speakers

Both tracks are recorded without echo cancellation. On speakers, the call is therefore recorded
twice: cleanly in the call-audio track and, a little later and quieter, in the microphone track.
The recorder does not remove this. To see how much there is in a recording:

```sh
npm run analyze:recording                 # the newest recording on this Mac
npm run analyze:recording -- <folder>     # a recording folder ("Open folder" in the app)
```

It prints, per track, whether it is silent, and for the microphone track the delay and level of
the call audio found in it. With headphones it reports none. It only reads the files.

## Development

```sh
nvm use
npm ci
cp config.example.json config.json
# Put only the PUBLIC Supabase anon JWT in config.json.
npm start
```

To see what a Mac on macOS 12.0 to 14.1 sees (the BlackHole path) on a newer Mac, start an
unpackaged run with `FORGENOTES_FAKE_MACOS_VERSION=13.6 npm start`. The variable is ignored in a
packaged app.

### Tests

```sh
npm run verify              # syntax and capture contracts
npm test                    # recording store; call-audio path choice, silence and echo maths, wording
npm run test:media-runtime  # in Electron: recording, and the call-audio measurements on recorded audio
npm run test:recorder-ui    # in Electron: the real window on both paths, with stand-in capture streams
```

None of these opens a real capture, so none of them can make macOS show a permission window.
Whether macOS actually hands over call audio has to be checked by a person, on a built app:

```sh
npm run pack:mac:dev
open "release/mac-arm64/ForgeNotes Recorder Dev.app"    # mac-x64 on an Intel Mac
```

`pack:mac:dev` builds an ad-hoc signed app with its own name and bundle identifier
(`ForgeNotes Recorder Dev`), so its permissions, recordings and sign-in stay separate from an
installed ForgeNotes Recorder. Run it from Finder or with `open`, not with `npm start`: macOS
attributes an unpackaged run to the terminal that started it, and the permission window then
names the terminal or does not appear at all. An ad-hoc build is a new app to macOS each time it
is rebuilt, so it asks again after every build.

Authentication is retained through Electron `safeStorage`. Use **Record locally** without signing in. **Stop & save** keeps audio on this device; the local library offers playback, folder access and optional **Upload & transcribe**. Auto-upload is opt-in. Successful uploads retain local copies until you discard them. Completed one-minute segments are checkpointed during capture; a crash can lose the current segment and an in-flight disk write.

## Reproducible internal build

The build refuses to package a missing or privileged Supabase key. Set the public anon JWT in the
environment (or provide a validated local `config.json`), then build:

```sh
export FORGENOTES_SUPABASE_ANON_KEY='public-anon-jwt'
npm ci
npm run dist:mac
```

This produces a universal `arm64` + `x86_64` application as `release/ForgeNotes-Recorder.dmg`
(for people installing by hand) and `release/ForgeNotes-Recorder.zip` plus
`release/latest-mac.yml` (which is what the auto-updater reads — Squirrel.Mac cannot update
from a DMG). The build command:

1. validates that the configured Supabase JWT has the `anon` role;
2. packages and signs every Electron executable with the Developer ID certificate under
   Hardened Runtime, with the `com.apple.security.device.audio-input` entitlement (it covers the
   microphone, the BlackHole input and native call audio) and the two usage descriptions macOS
   shows in its permission windows (`NSMicrophoneUsageDescription`,
   `NSAudioCaptureUsageDescription`);
3. submits the app to Apple for notarization, then staples the ticket to the app and the DMG
   so a first launch works offline;
4. mounts the DMG read-only and asserts signature authority, team ID, Hardened Runtime,
   Gatekeeper acceptance, bundle ID, and universal architectures.

Signing needs the Developer ID certificate in your keychain. Notarization additionally needs
`APPLE_API_KEY` (path to the App Store Connect `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
and `APPLE_TEAM_ID` in the environment. Without a certificate, use `npm run dist:mac:unsigned`
for a local development build — it will not be trusted by Gatekeeper and must not be shipped.

## Updates

Installed copies check GitHub Releases in the background and download new versions
automatically. Updates are applied on quit and never mid-session: restarting during a
recording would destroy an unrecoverable capture. The version badge shows "update ready"
once a new build is staged.

This means a release is only complete if `ForgeNotes-Recorder.zip` and `latest-mac.yml` are
attached to it. The release workflow fails the build if either is missing.

## GitHub release workflow

Repository secrets required:

| Secret | Contents |
| --- | --- |
| `FORGENOTES_SUPABASE_ANON_KEY` | The public Supabase anon JWT |
| `MAC_CERT_P12_BASE64` | Developer ID certificate + private key, exported as `.p12`, base64-encoded |
| `MAC_CERT_P12_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_API_KEY_BASE64` | App Store Connect `.p8` key, base64-encoded |
| `APPLE_API_KEY_ID` | Key ID of that key |
| `APPLE_API_ISSUER` | Issuer ID (one per team, not per key) |
| `APPLE_TEAM_ID` | `X36AQ2X3XN` |

Manual workflow dispatch publishes a release as well as building it. Pushing a matching version
tag (for example `v0.10.0`) also creates the GitHub release with the DMG, its SHA-256 checksum, and
the auto-update assets.

Long recordings remain segmented privately for reliable upload and processing. ForgeNotes creates
one continuous playback asset after upload; the segments are not presented to users.

## Current limitations

- On macOS 12.0 to 14.1, call audio requires BlackHole and Multi-Output routing.
- On macOS 14.2 and later, call audio is what plays through the Mac's current sound output; a
  meeting app playing through another device is not captured.
- Echo is not removed: on speakers the call is in both tracks.
- Updates apply on quit rather than immediately, so a user who never quits the app stays on
  the version they launched.

See [RELEASE.md](RELEASE.md) for the macOS 0.10.0 signing, notarization and distribution steps.
