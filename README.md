# ForgeNotes Recorder (macOS)

Supports two recording setups. **Online call** captures your microphone and BlackHole meeting
audio as separate tracks. **In person / room** captures one room microphone and tells ForgeNotes
to separate speakers during transcription.

This repository is the macOS recorder. It captures call audio through **BlackHole 2ch** rather
than ScreenCaptureKit, so it does not request screen-recording permission.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or 64-bit Intel Mac
- Node.js 24 for development and release builds
- BlackHole 2ch for capturing meeting audio

## Installation

The distributed DMG is signed with a Developer ID Application certificate (team
`X36AQ2X3XN`) and notarized by Apple, so it opens normally: drag to Applications and
launch. No quarantine command, no right-click → Open. See
[INTERNAL_INSTALL.md](INTERNAL_INSTALL.md) for installation and verification steps.

Installed copies update themselves — see [Updates](#updates).

## Recording setups

Choose **In person / room** when one microphone is capturing everyone nearby. BlackHole is hidden
and not required in this mode. Put the microphone near the center of the room and verify the live
level meter before recording.

Choose **Online call** for Zoom, Meet, Discord, and similar calls. Call audio uses the following
one-time BlackHole setup.

## One-time online-call audio setup

1. Install BlackHole:

   ```sh
   brew install blackhole-2ch
   ```

2. Open **Audio MIDI Setup** and create a **Multi-Output Device**.
3. Select both your normal speakers/headphones and **BlackHole 2ch**.
4. Route the meeting app's output to that Multi-Output Device.

The recorder's **You** and **Call audio** meters confirm that both tracks are receiving audio.

## Development

```sh
nvm use
npm ci
cp config.example.json config.json
# Put only the PUBLIC Supabase anon JWT in config.json.
npm start
```

Authentication is retained through Electron `safeStorage`. Recordings are written to disk before
upload; failed uploads remain in **Pending uploads** until retried or discarded.

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
   Hardened Runtime;
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

The workflow can be run manually to produce a verified artifact. Pushing a matching version
tag (for example `v0.7.0`) creates the GitHub release with the DMG, its SHA-256 checksum, and
the auto-update assets.

Long recordings remain segmented privately for reliable upload and processing. ForgeNotes creates
one continuous playback asset after upload; the segments are not presented to users.

## Current limitations

- Call audio requires BlackHole and Multi-Output routing.
- Updates apply on quit rather than immediately, so a user who never quits the app stays on
  the version they launched.
