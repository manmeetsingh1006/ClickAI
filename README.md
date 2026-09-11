# ClickAI

A document-aware AI assistant — a HeyClicky-style "buddy on screen" you
summon with a hotkey (desktop version), or a normal browser tab you keep
open (web version, see below).

## What it does

Press the hotkey → ClickAI opens a small overlay for strict,
document-grounded Q&A: it answers ONLY from whatever's actually retrieved
from your uploaded documents, citing excerpt numbers inline. No web
search, no screenshot, no filling gaps from general knowledge. If your
documents don't cover the question, it says so plainly instead of
guessing or making something up.

(ClickAI previously also had a Chat mode — a screen-aware general
assistant with live web search — but that was removed entirely on
2026-09-02 at the user's request. Docs is ClickAI's only mode now, on
both the desktop app and the web version.)

## Setup

```bash
npm install
npm run dev
```

On first launch:

1. Click the ⚙ settings icon in the overlay.
2. Paste your OpenAI API key (get one at platform.openai.com/api-keys).
3. Optionally change the model or hotkey.
4. Save.

Default hotkey: **Cmd+Shift+Space** (Mac) / **Ctrl+Shift+Space** (Win/Linux).
Press it to open the overlay; press it again to hide.

There's also a menu-bar tray icon (a small cursor+sparkle glyph) with
**Show ClickAI**, **Launch at Login**, and **Quit ClickAI** — a discoverable
alternative to the hotkey, and the cleanest way to actually quit the app,
which otherwise keeps running in the background when you close the
overlay window (by design, like a menu-bar app). "Launch at Login" is also
available as a checkbox in Settings — both control the same real macOS
login-item setting, so they're always in sync with each other.

## Documents (RAG)

Click **+ Add documents** to pick one or more files (PDF, DOCX, XLSX/XLSM,
PPTX/PPTM, HTML, PNG/JPG/GIF/WEBP/BMP, MP3/MP4/WAV/M4A/WEBM, TXT, MD, CSV,
JSON) via the native file picker — or just drag files straight onto the
Docs view. Each file is copied into a private, per-session temp folder, its
text extracted, split into overlapping chunks, and embedded
(`text-embedding-3-small`). Ask a question and ClickAI retrieves the most
relevant chunks from what you've uploaded.

ClickAI remembers your last few exchanges, so a follow-up like "how long
at the first one" can resolve against what you just asked — but only to
figure out what you're referring to. Every actual fact in an answer still
has to come from the retrieved document excerpts, never from something
only said earlier in the conversation. Answers cite excerpts inline like
`[1]`/`[2]`, and you can click "Show source excerpts" under any answer to
see the exact text behind each citation instead of taking it on faith.
Not happy with an answer? Hit **↻ Regenerate** to ask the same question
again.

Images (PNG/JPG/GIF/WEBP/BMP) are OCR'd via the vision model rather than a
classic OCR engine — upload a photo of a document, a scanned page, or a
screenshot full of text, and it gets transcribed and made searchable the
same way as any other document. This uses a small API call per image.

A scanned/photographed **PDF** page with no real text layer gets the same
vision-model OCR treatment automatically — any page whose extracted text
comes back essentially empty is rasterized (via poppler's `pdftoppm`; run
`brew install poppler` if you don't already have it — without it, a
scanned page just stays blank, no crash) and OCR'd, still tagged with its
real page number for citations. Pages that already have a text layer are
never touched by this.

Audio and video (MP3/MP4/MPEG/MPGA/M4A/WAV/WEBM) are transcribed via
OpenAI's `whisper-1` model with segment-level timestamps, so citations for
an audio/video document show a time range (e.g. `14:32–15:18`) instead of
a page number. For MP4/WEBM the audio track is transcribed server-side, no
local video processing needed. Limited to 25MB per file (the endpoint's
own limit); for a longer recording, trim it or export a lower-bitrate
version first.

Re-uploading a file you've already added in this session (same content,
detected by hash — renaming it doesn't dodge this) reuses the existing
chunks and embeddings instead of reprocessing it from scratch.

**Everything session-specific is ephemeral.** Documents, their
embeddings, and the conversation itself live only in this session —
hitting **Clear docs**, or simply quitting the app, deletes the temp
folder, all in-memory data, and the conversation memory described above
(clearing docs clears the conversation too, since a leftover Q&A log
referencing documents that no longer exist is confusing). A file over 20MB
gets a heads-up that it may take a little while (there's no hard size
limit on documents, only on audio/video — those are capped at 25MB by the
transcription endpoint itself; the web version also caps any single
upload at 100MB). The one exception is the cross-session processing cache
described below, which is anonymous and disk-persisted on purpose — see
that section for exactly what it does and doesn't retain.

## Performance & caching

A few cost-control mechanisms run behind the scenes, all best-effort
(never block or break an upload/answer if they fail) and all controllable
via `config.json`:

- **Cross-session processing cache** — the same file content (by hash,
  combined with the chunking/embedding settings in effect) uploaded in a
  *different* session, even after fully quitting and relaunching, skips
  re-parsing/OCR/chunking/embedding entirely. Persisted to disk keyed
  **only** by content hash + settings — never a session id, filename, or
  timestamp-as-identity — so there's nothing in an entry that reveals who
  uploaded it or when, only what it is. Entries expire after
  `processingCacheTtlHours` (default 24h) and can be turned off entirely
  via `processingCacheEnabled: false`.
- **Answer cache** — asking the exact same question again in the same
  session (same model, same document scope, same conversation history)
  returns the cached answer instead of a new LLM call. Automatically
  invalidated the moment you add or remove a document, so it never serves
  a stale answer against a changed document set.
- **Rate limiting** — a soft ceiling of 20 questions/minute and 50
  documents/session per user, mainly relevant to the web version with
  multiple concurrent logins; you'll get a clear error instead of the
  request silently hanging if you hit either.

## Packaging (building a real .dmg)

`npm run dev` runs ClickAI straight from source, which is fine for
development but means keeping a terminal window around. To build a real,
double-click-to-install app:

```bash
npm run dist:mac
```

This produces `release/ClickAI-<version>-arm64.dmg`, built for Apple
Silicon (the target architecture is set in `package.json`'s `build.mac`
config — change it if you ever need an Intel build). **This has to be run
on an actual Mac** — the final DMG step uses macOS's own `sips`/`hdiutil`
tools, which don't exist anywhere else. If you just want the unsigned
`.app` bundle without a DMG wrapper (e.g. to test the packaged build
faster), `npm run dist:mac:dir` skips straight to
`release/mac-arm64/ClickAI.app`.

The build isn't code-signed or notarized, so the first launch will need an
explicit "Open Anyway" in System Settings → Privacy & Security (or
right-click → Open) — this is normal for an app built outside the Mac App
Store without an Apple Developer certificate. On modern macOS, an
unsigned/ad-hoc-signed binary can also sit for a while (sometimes a minute
or more) on first launch after every rebuild while the OS's built-in
XProtect behavioral scan checks it out, since a fresh build gets a new
signature each time — that's not a bug in the app, just what running
unsigned Electron apps on macOS looks like without a paid Apple Developer
certificate to sign and notarize with.

## Web version (2026-09-02)

If you'd rather skip all the packaging/signing friction above entirely,
`npm run web` runs ClickAI as a plain local web server instead of a
packaged desktop app:

```bash
npm install
npm run web
```

Then open **http://localhost:4173** in your browser. No `.dmg`, no code
signing, no Gatekeeper/XProtect scans — it's just a Node process.

This is the same Docs backend as the desktop app (same RAG pipeline,
streaming, confidence badge, citations, conversation memory, retry
handling, drag-and-drop upload) and shares the same settings file, so an
API key saved in one is visible in the other. What it deliberately does
**not** have — these are desktop-overlay-only features with no real
browser equivalent, dropped per explicit choice when this was built:

- No global hotkey / always-on-top overlay window — it's a normal browser
  tab you keep open instead.
- No tray icon or "Launch at Login".

Change the port with `PORT=8080 npm run web` if 4173 is already taken by
something else on your machine.

## Project layout

```
src/
  main/       Shared logic: OpenAI calls, RAG store, settings, retry, doc parsing
              (used by BOTH the desktop app and the web server below)
  preload/    contextBridge API exposed to the desktop renderer
  renderer/   Desktop overlay UI (HTML/CSS/vanilla JS)
  server/     Express server exposing the web version's HTTP API
public/       Web version's browser UI (HTML/CSS/vanilla JS)
```

Config (API key, model, hotkey) is stored locally as a small JSON file in
`~/Library/Application Support/ClickAI/config.json` (macOS) — never
committed to this repo, shared by both the desktop and web versions, and
separate from the ephemeral document data described above.

## Roadmap

- [x] Streaming responses instead of single request/response
- [ ] Provider-agnostic settings (Anthropic/OpenAI toggle)
- [x] Tray icon, launch-at-login, packaged .dmg (electron-builder, macOS/arm64)
- [x] Support more document types (xlsx, pptx, images via OCR)
- [x] OCR fallback for scanned/image-only PDF pages
- [x] Timestamp citations for audio/video (segment-level, via whisper-1)
- [x] Duplicate-document detection (in-session and cross-session)
- [x] Answer caching + basic rate limiting
- [ ] Windows/Linux packaging targets
- [ ] Code signing + notarization (currently unsigned — needs an Apple Developer certificate)
- [ ] Persistent (non-ephemeral) document storage
