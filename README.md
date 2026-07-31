# ForgeNotes Recorder (macOS)

Records a meeting as two separate tracks — your microphone (`mic`) and the meeting/call audio
(`system`) — and uploads them into the ForgeNotes pipeline. Separate tracks transcribe more
reliably when people talk over each other.

This repository is the macOS recorder. It captures call audio through **BlackHole 2ch** rather
than ScreenCaptureKit, so it does not request screen-recording permission.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or 64-bit Intel Mac
- Node.js 24 for development and release builds
- BlackHole 2ch for capturing meeting audio

## Internal installation

The distributed DMG is intentionally ad-hoc signed and not notarized. That keeps the app free for
internal use, but macOS cannot establish publisher trust without an Apple Developer membership.
After copying the app to Applications, an internal user must remove the quarantine attribute once:

```sh
xattr -dr com.apple.quarantine "/Applications/ForgeNotes Recorder.app"
```

Do not disable Gatekeeper globally or use `sudo`. See [INTERNAL_INSTALL.md](INTERNAL_INSTALL.md)
for the complete installation and verification steps. Right-click → Open is not a dependable
workaround for an unnotarized Electron bundle.

## One-time audio setup

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

This produces `release/ForgeNotes-Recorder.dmg` as a universal `arm64` + `x86_64` application.
The build command:

1. validates that the configured Supabase JWT has the `anon` role;
2. packages and ad-hoc signs every Electron executable;
3. ad-hoc signs the outer DMG;
4. mounts the DMG read-only and runs strict signature, bundle-ID, and architecture checks.

Ad-hoc signing is selected deliberately with `mac.identity: "-"` and hardened runtime is disabled,
as recommended by electron-builder for unsigned internal distribution. It removes the malformed
signature that caused the old “damaged” installer, but it does **not** create Gatekeeper trust.

## GitHub release workflow

Add the repository secret `FORGENOTES_SUPABASE_ANON_KEY`, containing only the public Supabase anon
JWT. The macOS workflow can then be run manually to produce a verified artifact. Pushing a matching
version tag (for example `v0.4.0`) also creates the GitHub release with a stable
`ForgeNotes-Recorder.dmg` asset and SHA-256 checksum.

## Current limitations

- Call audio requires BlackHole and Multi-Output routing.
- The app is an internal build, so every freshly downloaded copy needs the one-time quarantine
  removal step.
- The app does not currently perform automatic updates; install new internal releases manually.
