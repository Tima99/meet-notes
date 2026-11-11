# MeetNotes

A privacy-first Chrome extension (MV3) that saves Google Meet transcripts from Meet's own live captions, with speaker names and timestamps. Everything stays in your browser: there is no server, no AI, no analytics, and no network access (`connect-src 'none'`).

**Status:** Phase 1 (extension skeleton + caption extraction) is done. Phases 2–4 are still to do.

## Architecture

```
┌──────────────── meet.google.com tab (content script) ────────────────┐
│                                                                      │
│  MeetDetector ──status──┐                                            │
│  (URL, in-call,         │                                            │
│   captions visible)     ▼                                            │
│                  CaptureController ── CaptureIndicator (on-page pill)│
│                         │                                            │
│  CaptionObserver ──snapshots──▶ CaptionTracker ──segments──▶ SegmentSink
│  (MutationObserver)      │      (pure logic: dedupe,        (batch,  │
│        │                 │       ordering, finalize)         retry)  │
│        ▼                 │                                     │     │
│  MeetCaptionParser       │                                     │     │
│  (selectors.ts + fallback)                                     │     │
└────────────────────────────────────────────────────────────────┼─────┘
                         chrome.runtime messages                 │
┌──────────────── service worker (background) ───────────────────▼─────┐
│  CaptureService ── CaptureRegistry (chrome.storage.session)          │
│        │        ── SegmentStore  (P1: memory → P2: IndexedDB)        │
│        │        ── badge "REC"                                       │
│        └──── PanelHub (ports) ──▶ side panel (React)                 │
└──────────────────────────────────────────────────────────────────────┘
```

| Module | File | Responsibility |
|---|---|---|
| Meet detector | `src/content/meet/meet-detector.ts` | Meeting code, title, in-call state, captions visibility |
| Caption observer | `src/content/captions/caption-observer.ts` | DOM mutations → snapshots of the visible caption blocks |
| Caption parser | `src/content/captions/caption-parser.ts` | Caption element → `{speaker, text}`, with a structural fallback |
| Caption tracker | `src/content/captions/caption-tracker.ts` | Snapshots → segments with unique IDs and ordering; handles dedupe and finalization |
| Selectors | `src/content/captions/selectors.ts` | **Every Meet DOM dependency in one place** |
| Transcript service, IndexedDB repository, meeting service | Phase 2 | — |
| Export service | Phase 4 | — |

### How caption tracking works

Meet shows one caption **block** per speaker turn. The text in a block grows word by word, recent words get revised, long blocks drop their oldest sentences, and old blocks scroll out of view. The tracker gives each block a segment and keeps it up to date (upsert by ID). A segment becomes `final` in any of these cases:

- a newer block has appeared below it and it hasn't changed for 2 s;
- it is the newest block and it hasn't changed for 5 s;
- its block has left the DOM and wasn't re-adopted within 1.5 s;
- captions are turned off, capture stops, or the meeting ends.

It handles these edge cases:

- **Slides:** Meet drops the oldest sentences from a long block. The dropped text is carried into the segment, so nothing is lost.
- **Resets:** Meet clears a block and starts it again. The old segment is finalized and a new one starts.
- **Hard shrinks:** a big drop in text length is treated as a reset, so text is never silently overwritten.
- **Re-renders:** if Meet redraws a caption with a new element, even with words it has rewritten in the meantime (for example after captions restart), the new element takes over the original entry. A block that has left the screen stays re-adoptable for 2 minutes. Genuinely new speech appears as a word or two and grows, so it is never merged into an old line.
- **Late corrections:** one caption block on screen is always one segment. If Meet corrects or extends a block after it was finalized (even mid-sentence, e.g. "There, usually" → "They're usually"), the same segment is amended. Its `revision` goes up and no duplicate is created.
- **Captions-area controls** (e.g. "Jump to bottom") are never read as captions.

Wording is never changed. The only normalization is collapsing whitespace.

### Hidden captions mode (default)

Meet only puts caption text on the page while captions are **on**. So on Start, MeetNotes:

- clicks Meet's own CC button for you, and clicks it again on Stop if it was MeetNotes that turned captions on;
- collapses Meet's **whole captions panel** to zero height: the caption text, language picker and font buttons all disappear and the video grid gets the space back. The panel is found by climbing up from the caption region, and the climb stops before any element that holds participant tiles, video or the call toolbar (`src/content/meet/caption-panel.ts`). The panel stays rendered, so caption text keeps arriving and capture keeps working;
- makes Meet lay out its page again. Meet only works out the captions panel's size when captions start (or the language changes), so hide mode is switched on *before* MeetNotes turns captions on. If captions were already on, MeetNotes switches them off and on once with Meet's CC button. Stop waits for that to finish;
- moves the **caption-language** choice into the side panel. It operates Meet's own hidden picker. Showing the current language never opens Meet's menu; the menu opens briefly only when you click *Change*.

You can switch this off with *Hide captions in Meet while capturing* in the side panel.

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | The UI |
| `storage` | `chrome.storage.session` only, so an active capture survives service-worker restarts. It lives in memory, is never synced, and content scripts can't read it. |
| content script on `https://meet.google.com/*` | Read captions. This is the only site access. |

The extension does **not** request `tabs`, `scripting`, `activeTab`, `<all_urls>`, or any host permissions. IndexedDB (Phase 2) needs no permission.

## Folder structure

```
public/manifest.json
src/
  shared/        types, message protocol, logger, clock
  content/       content script: detector, captions/{observer,parser,tracker,selectors}, controller, sink, indicator
  background/    service worker: capture service, registry, segment store, panel hub, badge
  sidepanel/     React UI
tests/           Vitest unit tests + jsdom Meet simulation (tests/fixtures/fake-meet.ts)
```

## Develop

```bash
npm install
npm test          # 85 tests: tracker, parser, observer, detector, sink, controller, end-to-end simulation
npm run build     # typecheck + build into dist/
npm run dev       # rebuild on change
```

Load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `dist/`. After each rebuild, click the reload icon on the extension card **and refresh the Meet tab**.

## Phase 1: manual test plan

Start a meeting at meet.google.com. You can do this alone: talk into your mic, or play a video with speech near it. For several speakers, join from a second account in an incognito window or on your phone. Click the toolbar icon to open the side panel.

To see logs, open DevTools on the Meet tab, pick the **MeetNotes** content-script context in the console dropdown, and filter on `MeetNotes`. Caption text is only logged in dev builds (`npm run dev`).

| # | Scenario | Expected |
|---|---|---|
| 1 | Open Meet, don't press Start, and talk | Nothing appears and there is no badge or pill. Capture never starts on its own. |
| 2 | Press **Start** with captions off | The "REC" badge appears, the pill turns amber ("turn on captions"), and the panel shows a warning. |
| 3 | Press **C** to turn captions on and speak | The pill turns red. A segment appears in the panel and grows as you talk. Interim segments have a dashed border. |
| 4 | Two people take turns | Separate segments with the right names, in chronological order |
| 5 | Talk for about 60 s without pausing | One segment holds the whole monologue, even after Meet trims the start of its caption block. |
| 6 | Pause for 5 s, then keep talking | The first segment becomes final (solid border) and a new segment starts. |
| 7 | Wait for old captions to scroll away | They stay final and are not duplicated. |
| 8 | Turn captions off and on again (C, C) | Open segments become final and new speech starts new segments. Nothing is duplicated. |
| 9 | Resize the window or switch layouts while someone speaks | No duplicate segments |
| 10 | Switch to another tab while others talk, then come back | Segments kept arriving in the background. |
| 11 | Press **Stop** | The badge and pill disappear and every segment is final. |
| 12 | Start again, then leave the call | Capture stops automatically after about 3 s. |
| 13 | Reload the extension while capturing | The pill disappears from the old tab. Refresh the tab to use MeetNotes again. |

**Known Phase 1 limitation:** segments are kept in the service worker's memory, so they are lost when Chrome suspends it after a long idle period. Phase 2 fixes this with IndexedDB.

**If captions aren't detected** (the pill stays amber while captions are visible), Meet has probably changed its DOM. Inspect the captions area and update `src/content/captions/selectors.ts`. A `strategy.changed → structural` warning in the console means the fallback parser is in use.

## Roadmap

1. ~~Extension + caption extraction~~
2. IndexedDB (`meetings` and `transcripts` stores, indexed on `meetingId`, `timestamp`, `startedAt`). A transcript service and meeting service will save final segments immediately and checkpoint interim ones.
3. React side panel: dashboard, meeting history, transcript viewer
4. TXT and JSON export
