# macOS 0.10.0 release

This repository ships macOS only. Windows ships from `fecktk1/forgenotes-recorder` as version 1.0.0. The source changes are on `codex/forgenotes-reliability-20260908`; merge the reviewed pull request into `main` before publishing.

The current release path is a Developer ID signed, Apple-notarized universal DMG plus ZIP and update metadata, distributed through GitHub. It is not a Mac App Store submission. Keep the existing signing, hardened runtime, entitlements, live captions, capture tags, BlackHole input and automatic updater.

## Recommended build and publication: GitHub Actions

The following secret names were present when checked; their values and validity still need to succeed in the release job:

- `FORGENOTES_SUPABASE_ANON_KEY`
- `MAC_CERT_P12_BASE64`
- `MAC_CERT_P12_PASSWORD`
- `APPLE_API_KEY_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Open **Actions → Build macOS release → Run workflow**, select merged `main`, and run it once. **Manual dispatch signs, notarizes and publishes v0.10.0**, including creating its tag. Alternatively push the matching `v0.10.0` tag once; do not use both triggers.

From any authenticated GitHub CLI, including this Windows machine:

```sh
gh workflow run release-macos.yml --repo fecktk1/forgenotes-recorder-mac --ref main
gh run list --repo fecktk1/forgenotes-recorder-mac --workflow release-macos.yml --limit 5
# Replace RUN_ID with the new run's numeric ID:
gh run watch RUN_ID --repo fecktk1/forgenotes-recorder-mac --exit-status
gh release view v0.10.0 --repo fecktk1/forgenotes-recorder-mac
```

The workflow uses a Mac runner, imports the Developer ID certificate into a temporary keychain, submits to Apple's notarization service and verifies the resulting app. You do not manually upload this DMG in App Store Connect. A Mac App Store launch would require a separate MAS build, provisioning and submission workflow, which this repository does not currently implement.

Verify the release contains all of:

- `ForgeNotes-Recorder.dmg`
- `ForgeNotes-Recorder.dmg.sha256`
- `ForgeNotes-Recorder.zip`
- `latest-mac.yml`
- Generated blockmaps when present

The ZIP and `latest-mac.yml` are essential to automatic updates; a DMG alone does not update existing installations. If signing/notarization fails, fix the certificate or Apple API configuration; do not distribute an unsigned fallback as this release. Inspect any partial release before retrying. Do not move a tag already used for a distributed build.

## Build locally on a Mac without publishing

In the macOS repository checkout:

```sh
git fetch origin
git switch codex/forgenotes-reliability-20260908
git pull --ff-only
nvm use
npm ci
npm run verify
npm test
npm run dist:mac
```

Use Node.js 24. The signed build requires the existing Developer ID certificate and private key in your keychain (or `CSC_LINK` and `CSC_KEY_PASSWORD`), the public anon configuration, and these notarization environment variables: `APPLE_API_KEY` pointing to a local `.p8` file, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. Supply values from your secure credential storage, never from committed files. The certificate and team must match the repository's signing configuration. `dist:mac` builds and notarizes but uses `--publish never`.

`npm run dist:mac:unsigned` exists for development without signing credentials. It does not produce a distributable release and does not replace signed-build verification.

## Installation and native acceptance check

Download the signed DMG, drag ForgeNotes Recorder into Applications, eject the DMG, then launch and grant microphone permission. Verify trust:

```sh
spctl --assess -vvv --type exec "/Applications/ForgeNotes Recorder.app"
codesign -dv --verbose=4 "/Applications/ForgeNotes Recorder.app" 2>&1 | grep -E 'Authority|TeamIdentifier'
```

Expect `Notarized Developer ID` and team `X36AQ2X3XN`. A correctly signed/notarized release should not require quarantine removal or disabling Gatekeeper.

Test room recording without login, pause/resume, Stop & save, local playback and folder access. For online calls, use the README's BlackHole 2ch + Multi-Output Device setup and verify both audio tracks. Test recovery after a completed one-minute checkpoint, existing capture tags, and optional live captions. Captions may download their model on first use; turn them off when verifying fully offline capture. Sign in, upload, confirm server processing, and confirm local retention. Test updates from 0.9.0 to 0.10.0 after the release is available; updates apply on quit.

Windows-hosted syntax/storage/Chromium checks passed, with optional caption model download disabled. They do not prove native BlackHole capture, Apple signing/notarization or updater installation. Those remain Mac acceptance checks.
