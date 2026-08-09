# Installing ForgeNotes Recorder on macOS

ForgeNotes Recorder is signed with an Apple Developer ID certificate and notarized by
Apple, so it installs like any other Mac app. There is no security warning to work
around and no Terminal command to run.

## Install

1. Download `ForgeNotes-Recorder.dmg` from the latest release.
2. Open the DMG and drag **ForgeNotes Recorder** into **Applications**.
3. Eject the DMG.
4. Open ForgeNotes Recorder from Applications and approve microphone access when asked.

## Updates

The app checks for new versions in the background and downloads them automatically.

An update is **never installed while the app is open**, because a restart in the middle
of a meeting would destroy the recording. When a new version is ready the version badge
in the header reads *"update ready"*; the update is applied the next time you quit, and
the new version is what launches after that. Quitting and reopening applies it
immediately if you would rather not wait.

## Verify the build

You can confirm the app is genuinely signed and notarized:

```sh
spctl --assess -vvv --type exec "/Applications/ForgeNotes Recorder.app"
```

It must report `source=Notarized Developer ID`. To confirm which publisher signed it:

```sh
codesign -dv --verbose=4 "/Applications/ForgeNotes Recorder.app" 2>&1 | grep -E 'Authority|TeamIdentifier'
```

The team identifier is `X36AQ2X3XN`.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon or 64-bit Intel Mac (the build is universal)
- BlackHole 2ch and a Multi-Output Device for capturing call audio
