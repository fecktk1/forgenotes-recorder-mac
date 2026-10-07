# October 2026 security release

Electron 44.6.0 updates the browser/media engine (Chromium 152, Node 24.18). **It requires macOS 13 Ventura or later**: `minimumSystemVersion` is now 13.0, and the release workflow adds `minimumSystemVersion: 22.0.0` (Darwin 22 = macOS 13) to `latest-mac.yml`, so electron-updater on a macOS 12 install skips the update instead of installing an app that will not open. Monterey users stay on 0.10.x.

The window only shows the app's own page (navigation and new windows elsewhere are refused) and IPC is answered only for that page. The sign-in token is stored only when the Keychain can encrypt it (safeStorage); otherwise it is kept in memory for that run, the reason is written to `upload-log.txt`, and the user signs in again on the next launch. Plaintext tokens are never written, and one left by an older version is deleted.

Dependency audits must pass without exceptions. Native CI checks microphone encoding, separate synthesized system audio, room capture, pause/resume, and decoded output, plus recording recovery contracts, token storage, and the sandboxed shell (`npm run test:shell`). These are synthetic checks and do not validate physical devices or routing.

Manual workflow dispatch defaults to a draft release. Promote only after testing physical microphone and system audio separately and together, a long recording, pause/resume, sleep/wake, authentication (sign in, quit, relaunch: still signed in), upload and retry, playback of a saved recording, opening a meeting in the browser, live captions/model loading, both supported architectures, and installation/update on macOS 13 or later. Check that `latest-mac.yml` in the draft carries `minimumSystemVersion: 22.0.0`.

Record the tested OS, device/routing, version, and results with the release before promotion. A draft's auto-update metadata is not served as the latest public release.
