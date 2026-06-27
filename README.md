# ForgeNotes Recorder (macOS)

Records a meeting as **two separate tracks** — your microphone (`mic`) and the meeting/call
audio (`system`) — and uploads them straight into the ForgeNotes pipeline (the same
`create-session → upload-file → finalize-session` flow the web app uses). Two clean tracks
transcribe far better than one mixed track when people talk over each other.

> This is the **macOS** build. The Windows build lives in a separate repo and captures system
> audio via WASAPI loopback; macOS uses **BlackHole** instead (no screen-recording permission,
> no native Swift/ScreenCaptureKit). The app UI, upload flow, and offline queue are the same.

## How audio capture works on macOS

macOS apps can't grab "system audio" directly, so we use **BlackHole 2ch**, a free virtual audio
device. You route the meeting's sound into BlackHole; the recorder then captures BlackHole as just
another input device (via `getUserMedia`). Your microphone is captured the same way.

- **Microphone** → captured from the mic you pick.
- **Meeting / call audio** → captured from the **BlackHole 2ch** input you pick.

The live **You / Call audio** meters in the app show whether each track is actually receiving
sound — the Call meter moving means BlackHole is correctly routed.

## One-time setup

1. **Install Node + BlackHole**
   ```sh
   brew install node
   brew install blackhole-2ch
   ```
2. **Create a Multi-Output Device** (so you still HEAR the call while it's also sent to BlackHole):
   - Open **Audio MIDI Setup** (Spotlight → "Audio MIDI Setup").
   - Click **+** (bottom-left) → **Create Multi-Output Device**.
   - Tick **both** your normal output (e.g. MacBook speakers / headphones) **and** **BlackHole 2ch**.
   - Name it e.g. "Meeting Output".
3. **Route the meeting to it:** set your Mac's **output** to that Multi-Output Device (or set the
   meeting app's output device to BlackHole 2ch) while recording. You'll still hear the call, and
   BlackHole receives a copy for capture.

## First-time run (dev)

```sh
npm install
cp config.example.json config.json
# open config.json and paste the PUBLIC Supabase anon key into "supabaseAnonKey"
npm start
```
The anon key is the same value the web app ships (`VITE_SUPABASE_ANON_KEY` in Netlify). Never put
the service-role key here. `config.json` is git-ignored.

## Using it

1. **Sign in** with your ForgeNotes account (must be on the allowlist). Stays signed in (encrypted
   token via macOS Keychain/safeStorage).
2. Pick your **Microphone**, and set **System audio source** to **BlackHole 2ch** (the app
   auto-selects it if it sees it).
3. **Start recording.** Watch the meters: **You** moves when you talk; **Call audio** moves when the
   meeting plays through BlackHole. If "Call audio" stays flat, your Multi-Output routing isn't
   sending the meeting into BlackHole.
4. **Stop & upload** → **Open in ForgeNotes**; it transcribes with both speaker tracks.

## Offline / failed uploads

Every recording is written to disk before upload. A failed upload (offline, expired token) shows
under **Pending uploads** with **Retry** / **Discard** — nothing is lost. A successful upload
removes the local copy.

## Building a `.dmg`

```sh
npm run dist:mac
```
This is **ad-hoc signed** (`identity: null`) — no Apple Developer ID, no notarization. On first
launch macOS will warn about an unidentified developer; **right-click the app → Open** once to
approve it. Acceptable for internal/single-user use. `NSMicrophoneUsageDescription` is set so the
mic-permission prompt has a reason string.

## Notes / limitations (v1)

- Each track uploads as a single complete `*.webm` (Opus) file (`seq: 0`), like a web manual upload;
  the transcription worker speaker-labels `mic` vs `system`.
- Requires the BlackHole + Multi-Output routing above — that's the macOS price for clean system audio
  without screen-recording permissions.
