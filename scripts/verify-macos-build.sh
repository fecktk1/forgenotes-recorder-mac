#!/usr/bin/env bash
set -euo pipefail

# Verifies that a release DMG is something Gatekeeper will actually open on a machine
# that has never seen it before. Signing alone is not enough: an app can carry a valid
# Developer ID signature and still be blocked because it was never notarized, or because
# the notarization ticket was not stapled and the user is offline on first launch. Each
# check below maps to a distinct way that can go wrong.

dmg_path="${1:-release/ForgeNotes-Recorder.dmg}"
app_name="ForgeNotes Recorder.app"
expected_bundle_id="io.thecontentforge.forgenotes.recorder.mac"
expected_team_id="${FORGENOTES_TEAM_ID:-X36AQ2X3XN}"

if [[ ! -f "$dmg_path" ]]; then
  echo "Missing DMG: $dmg_path" >&2
  exit 1
fi

hdiutil verify "$dmg_path"

# The DMG container is deliberately NOT required to be signed. electron-builder signs and
# notarizes the .app, not the disk image, and Gatekeeper's decision is made about the app:
# a stapled ticket on the app is what allows a clean first launch, offline. An unsigned DMG
# yields at most the ordinary "downloaded from the internet" confirmation every app shows.
# What must be true is asserted below, against the app inside.

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

if grep -q '^Signature=adhoc$' <<<"$signature_details"; then
  echo "App is ad-hoc signed — Gatekeeper cannot identify the publisher." >&2
  exit 1
fi

if ! grep -q "^Authority=Developer ID Application: .*(${expected_team_id})$" <<<"$signature_details"; then
  echo "App is not signed by the expected Developer ID Application certificate:" >&2
  grep '^Authority=' <<<"$signature_details" >&2 || echo "  (no Authority line at all)" >&2
  exit 1
fi

if ! grep -q "^TeamIdentifier=${expected_team_id}$" <<<"$signature_details"; then
  echo "Unexpected TeamIdentifier (wanted ${expected_team_id}):" >&2
  grep '^TeamIdentifier=' <<<"$signature_details" >&2
  exit 1
fi

# Notarization is rejected outright without Hardened Runtime, so a build that lost this
# flag would fail much later and much more confusingly.
if ! grep -q 'flags=.*runtime' <<<"$signature_details"; then
  echo "App is not built with Hardened Runtime." >&2
  grep '^CodeDirectory' <<<"$signature_details" >&2
  exit 1
fi

# The real question: does this machine's Gatekeeper accept it? Prints
# "source=Notarized Developer ID" when the app is both signed and notarized.
assessment="$(spctl --assess -vvv --type exec "$app_path" 2>&1)"
echo "$assessment"
if ! grep -q 'source=Notarized Developer ID' <<<"$assessment"; then
  echo "Gatekeeper did not report a notarized Developer ID app." >&2
  exit 1
fi

xcrun stapler validate "$app_path"

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

echo
echo "Verified: notarized Developer ID signature (team ${expected_team_id}), Hardened Runtime,"
echo "stapled ticket on the app, universal arm64/x86_64 ($mach_count Mach-O files)."
echo "Gatekeeper accepts this build with no quarantine workaround."
