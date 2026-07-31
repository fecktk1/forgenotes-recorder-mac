# Installing ForgeNotes Recorder on macOS

ForgeNotes Recorder is an internal tool. It is intentionally **ad-hoc signed** and is not
notarized because the project does not use a paid Apple Developer membership. The build is
cryptographically self-consistent, but Apple Gatekeeper cannot identify its publisher.

## Install

1. Download `ForgeNotes-Recorder.dmg` from the internal GitHub release.
2. Open the DMG and drag **ForgeNotes Recorder** into **Applications**.
3. Eject the DMG.
4. Open Terminal and run:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/ForgeNotes Recorder.app"
   ```

5. Open ForgeNotes Recorder from Applications and approve microphone access.

The command removes only the quarantine attribute that macOS adds to downloaded files. Do not
use `sudo`, disable Gatekeeper globally, or change any other security settings.

## Verify the internal build

You can confirm that the app bundle has not been modified since it was packaged:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/ForgeNotes Recorder.app"
lipo -archs "/Applications/ForgeNotes Recorder.app/Contents/MacOS/ForgeNotes Recorder"
```

The first command must succeed. The second must print both `x86_64` and `arm64`.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or 64-bit Intel Mac
- BlackHole 2ch and a Multi-Output Device for capturing call audio
