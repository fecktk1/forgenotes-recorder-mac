#!/usr/bin/env bash
set -euo pipefail

# Checks that a built ForgeNotes Recorder app can record call audio and the microphone.
# Run by verify-macos-build.sh on the release DMG's app, and usable on its own on any
# build, including the ad-hoc signed development one:
#
#   bash scripts/verify-call-audio-bundle.sh "release/mac-arm64/ForgeNotes Recorder Dev.app"
#
# Each check is a way capture can fail without a word at runtime:
#
#   * NSAudioCaptureUsageDescription. On macOS 14.2 and later call audio is recorded with
#     a Core Audio tap. macOS shows this sentence in its permission window and lists the
#     app under "System Audio Recording Only". Electron's own Info.plist carries a generic
#     sentence, so the check is that the app's sentence replaced it.
#   * NSMicrophoneUsageDescription. Without it macOS refuses the microphone outright.
#   * com.apple.security.device.audio-input on the app and on every helper. Under Hardened
#     Runtime this entitlement is what lets a process record audio. Chromium opens the
#     microphone, the BlackHole input and the tap in its audio service, which runs in a
#     helper; a helper without it gets no permission prompt and a dead stream.
#
# No screen-capture permission is checked for, because the app never asks for one.

app_path="${1:?usage: verify-call-audio-bundle.sh <path to .app>}"
info_plist="$app_path/Contents/Info.plist"

if [[ ! -f "$info_plist" ]]; then
  echo "Not an app bundle: $app_path" >&2
  exit 1
fi

for key in NSAudioCaptureUsageDescription NSMicrophoneUsageDescription; do
  value="$(plutil -extract "$key" raw -o - "$info_plist" 2>/dev/null || true)"
  if [[ "$value" != *"ForgeNotes Recorder"* ]]; then
    echo "Info.plist $key is missing or is not the app's own sentence: ${value:-<missing>}" >&2
    exit 1
  fi
done

helpers=()
while IFS= read -r -d '' helper; do
  helpers+=("$helper")
done < <(find "$app_path/Contents/Frameworks" -maxdepth 1 -type d -name '*Helper*.app' -print0)

if [[ "${#helpers[@]}" -eq 0 ]]; then
  echo "No Electron helper apps found in $app_path/Contents/Frameworks" >&2
  exit 1
fi

for bundle in "$app_path" "${helpers[@]}"; do
  entitlements="$(codesign -d --entitlements - --xml "$bundle" 2>/dev/null || true)"
  if [[ "$entitlements" != *"com.apple.security.device.audio-input"* ]]; then
    echo "Missing the com.apple.security.device.audio-input entitlement: $bundle" >&2
    exit 1
  fi
done

echo "Call audio: both usage descriptions are the app's own; audio-input entitlement on the app and ${#helpers[@]} helpers."
