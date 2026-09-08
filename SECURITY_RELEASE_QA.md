# September 2026 security release

Electron 43.6.0 updates the browser/media engine while preserving macOS 12 compatibility. Dependency audits must pass without exceptions. Native CI checks microphone encoding, separate synthesized system audio, room capture, pause/resume, and decoded output, plus recording recovery contracts. These are synthetic checks and do not validate physical devices or routing.

Manual workflow dispatch defaults to a draft release. Promote only after testing physical microphone and system audio separately and together, a long recording, pause/resume, sleep/wake, authentication, upload and retry, and installation/update on the supported OS. macOS additionally requires live captions/model loading and both supported architectures. Store APPX submission is a separate release step; do not replace a pending submission automatically.

Record the tested OS, device/routing, version, and results with the release before promotion. A draft's auto-update metadata is not served as the latest public release.
