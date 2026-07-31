#!/usr/bin/env bash
set -euo pipefail

dmg_path="${1:-release/ForgeNotes-Recorder.dmg}"
app_name="ForgeNotes Recorder.app"
expected_bundle_id="io.thecontentforge.forgenotes.recorder.mac"

if [[ ! -f "$dmg_path" ]]; then
  echo "Missing DMG: $dmg_path" >&2
  exit 1
fi

hdiutil verify "$dmg_path"
codesign --verify --strict --verbose=2 "$dmg_path"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/forgenotes-verify.XXXXXX")"
cleanup() {
  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg_path" >/dev/null
app_path="$mount_dir/$app_name"

if [[ ! -d "$app_path" ]]; then
  echo "DMG does not contain $app_name" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_path"

signature_details="$(codesign -d --verbose=4 "$app_path" 2>&1)"
if ! grep -q '^Signature=adhoc$' <<<"$signature_details"; then
  echo "Expected an intentional ad-hoc app signature." >&2
  exit 1
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app_path/Contents/Info.plist")"
if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  echo "Unexpected bundle identifier: $bundle_id" >&2
  exit 1
fi

main_executable="$app_path/Contents/MacOS/ForgeNotes Recorder"
main_archs="$(lipo -archs "$main_executable")"
if [[ " $main_archs " != *" arm64 "* || " $main_archs " != *" x86_64 "* ]]; then
  echo "Main executable is not universal: $main_archs" >&2
  exit 1
fi

mach_count=0
while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -q '^Mach-O'; then
    mach_count=$((mach_count + 1))
    candidate_archs="$(lipo -archs "$candidate")"
    if [[ " $candidate_archs " != *" arm64 "* || " $candidate_archs " != *" x86_64 "* ]]; then
      echo "Non-universal Mach-O: $candidate ($candidate_archs)" >&2
      exit 1
    fi
  fi
done < <(find "$app_path/Contents" -type f -perm -111 -print0)

if [[ "$mach_count" -eq 0 ]]; then
  echo "No Mach-O executables found in app bundle." >&2
  exit 1
fi

echo "Verified valid ad-hoc signatures and universal arm64/x86_64 binaries ($mach_count Mach-O files)."
echo "Gatekeeper trust is intentionally unavailable; internal users must remove quarantine after copying the app."
