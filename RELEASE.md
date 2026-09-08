# macOS recorder release

This repository ships macOS only. Windows ships separately from `fecktk1/forgenotes-recorder`.

## September 8, 2026 delivery

[macOS v0.10.1](https://github.com/fecktk1/forgenotes-recorder-mac/releases/tag/v0.10.1) is published from `e0f732a7f6f73c43b27977a17bea651294f44ef1`. Native workflow run `34260279878` passed universal packaging, Developer ID signing, Apple notarization, Gatekeeper/stapling and updater-asset checks. The maintainer confirmed successful physical capture, sleep/wake, upload/retry, install/update and captions/model-loading checks. Exact device/OS details were not recorded.

This is a signed/notarized **GitHub distribution**, not a Mac App Store submission. Nothing needs uploading to App Store Connect for this release. The DMG, ZIP, blockmaps, DMG checksum and `latest-mac.yml` are public.

Install `ForgeNotes-Recorder.dmg`, drag the app to Applications, eject the DMG and open the app. Approve microphone permission. macOS 12 or newer is supported, on Apple Silicon or 64-bit Intel. Online-call audio uses the README's BlackHole 2ch and Multi-Output Device setup. Existing installations receive the updater feed; updates apply on quit. See [INTERNAL_INSTALL.md](INTERNAL_INSTALL.md).

## Prepare a future version

Make changes in this repository on a branch from current `main`. Bump `package.json` and `package-lock.json` together to a **new, unused version**, then review and merge. Do not move an existing distributed tag or rebuild over v0.10.1.

The GitHub workflow uses these existing secret names: `FORGENOTES_SUPABASE_ANON_KEY`, `MAC_CERT_P12_BASE64`, `MAC_CERT_P12_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. Keep secret values out of source and logs.

Only after merging a new package version, run:

```sh
gh workflow run release-macos.yml --repo fecktk1/forgenotes-recorder-mac --ref main -f draft=true
gh run list --repo fecktk1/forgenotes-recorder-mac --workflow release-macos.yml --limit 5
# Replace RUN_ID with that run's ID:
gh run watch RUN_ID --repo fecktk1/forgenotes-recorder-mac --exit-status
```

Manual dispatch defaults to a draft and creates `v<package.json version>` at the workflow commit. A tag push publishes immediately; do not use both triggers. Inspect a failed or partial run before retrying.

The Mac runner imports the Developer ID certificate into a temporary keychain, builds the universal app, submits to Apple's notarization service and verifies trust. Do not distribute an unsigned fallback if signing or notarization fails. A Mac App Store launch would require a separate MAS build/provisioning/submission workflow, which this repository does not implement.

The draft must contain `ForgeNotes-Recorder.dmg`, its checksum, `ForgeNotes-Recorder.zip`, `latest-mac.yml` and generated blockmaps. The ZIP and YAML are required for automatic updates; a DMG alone is insufficient. Complete [SECURITY_RELEASE_QA.md](SECURITY_RELEASE_QA.md) on the exact artifacts, including physical BlackHole/microphone capture and captions. Then replace VERSION with the new package version:

```sh
gh release edit vVERSION --repo fecktk1/forgenotes-recorder-mac --draft=false --latest
gh release view vVERSION --repo fecktk1/forgenotes-recorder-mac
```

## Build locally on a Mac without publication

```sh
git fetch origin
git switch main
git pull --ff-only
nvm use
npm ci
npm run verify
npm test
npm run test:media-runtime
npm run dist:mac
```

Use the repository's Node version and existing Developer ID credentials. Signed local builds need the certificate/private key or `CSC_LINK`/`CSC_KEY_PASSWORD`, public anon configuration, and notarization variables `APPLE_API_KEY` (path to the private `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` and `APPLE_TEAM_ID`. `dist:mac` uses `--publish never`. `dist:mac:unsigned` is only for development.

Verify the installed release:

```sh
spctl --assess -vvv --type exec "/Applications/ForgeNotes Recorder.app"
codesign -dv --verbose=4 "/Applications/ForgeNotes Recorder.app" 2>&1 | grep -E 'Authority|TeamIdentifier'
```

Expect `Notarized Developer ID` and team `X36AQ2X3XN`. Test room/online capture, pause/resume, checkpoint recovery, local playback, tags, captions/model loading, upload and local retention. Confirm an existing installation updates to the new version. Native CI, Apple notarization and physical-device results are separate checks.
