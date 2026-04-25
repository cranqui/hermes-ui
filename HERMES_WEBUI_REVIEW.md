# Hermes WebUI Review — Recommendations for Our App

> **Source:** [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) (v0.50.36, April 2026)
> **Our app:** Electron + vanilla JS chat client for Hermes Agent API
> **Date:** 2026-04-25
> **Purpose:** Comparative analysis — what Hermes WebUI does well that we should adopt, adapt, or reject, organized by A) Architecture & Security, B) Functionalities, C) UX.

---

## Context: Key Architectural Difference

| | Our App (Electron) | Hermes WebUI (Python stdlib) |
|---|---|---|
| Runtime | Electron 41 (Chromium shell) | Python `http.server.ThreadingHTTPServer` |
| Frontend | Vanilla JS, hand-rolled DOM | Vanilla JS, hand-rolled DOM (same approach!) |
| State | localStorage (client-side) | Server-side JSON files per session + in-memory cache |
| Streaming | SSE from Hermes API → main.js → IPC → renderer | SSE from own Python server → direct JS EventSource |
| Agent access | HTTP API only (stateless proxy) | Imports `AIAgent` Python class directly (in-process) |
| Auth | None (local Electron app) | Password auth with PBKDF2, signed cookies, CSRF |
| Session model | Hermes API sessions (server-side) | Own session model (WebUI creates and owns sessions) |

**Critical distinction:** Hermes WebUI is a **full-stack app** that imports the Hermes agent as a Python module. We are a **thin client** that talks to the Hermes gateway API over HTTP. This means some of their architecture (in-process agent, session ownership, file uploads to workspace) doesn't apply to us, while other patterns (streaming, auth, error handling) are directly transferable.

---

## A) Architecture & Security

### A1. Streaming Architecture: Two-Endpoint Split ✅ ADOPT

**What they do:** Split streaming into two endpoints:
- `POST /api/chat/start` → creates a queue, spawns a daemon thread running the agent, returns `{stream_id}` immediately
- `GET /api/chat/stream?id=STREAM_ID` → long-lived SSE connection reading from that queue

**Why it matters:** This decouples the request lifecycle from the response stream. The user gets a stream ID instantly, and the actual SSE connection is a separate GET request. This enables:
- Cancel: `GET /api/chat/cancel?stream_id=X` kills the agent thread
- Reconnect: if SSE drops, the client reconnects with the same `stream_id`
- Multi-tab: different browser tabs can subscribe to the same stream

**Our current approach:** Single `POST /v1/chat/completions` request with SSE response. If the connection drops mid-stream, we lose everything.

**Recommendation:** We can't change the upstream Hermes API, but we CAN proxy through our Electron main process using the same two-endpoint pattern. Main process creates a Hermes API request, gets a stream ID, and the renderer connects to a local SSE-like channel using that ID. This enables cancel and reconnect without touching the API.

**Effort:** Medium.

---

### A2. Session-Aware Concurrency Control ✅ ADOPT

**What they do:** Per-session locks prevent concurrent agent runs on the same session:
```python
SESSION_AGENT_LOCKS = {}  # dict: session_id → Lock
```
If user sends a second message while the first is streaming, it's either queued or rejected with a clear conflict message.

**Our current approach:** No concurrency guard. If user clicks "Send" twice, two parallel requests hit the API with the same session ID. The stateful Hermes session would process both, causing interleaved responses and context corruption.

**Recommendation:** Add `INFLIGHT` tracking in main.js (they already have this pattern in `ui.js`). Block "Send" while busy. If a conflict is detected, offer "Queue message" rather than silently sending.

**Effort:** Low. We already disable the send button during streaming, but need explicit conflict handling for rapid interactions.

---

### A3. Password Authentication ✅ ADOPT (adapted)

**What they do:** Optional password auth (PBKDF2-SHA256, 600k iterations, HMAC-signed session cookies, 24h TTL), rate limiting (5 attempts/60s per IP), auto-login after password enable.

**Our current approach:** None — we're a local Electron app so it's less critical.

**Recommendation:** Not needed for local Electron use. BUT if we ever expose the app over the network (remote access), we should add basic auth. For now: skip, but keep in mind if remote access is added.

**Effort:** N/A for now.

---

### A4. CSRF Protection ✅ ADOPT (adapted)

**What they do:** Origin/Referer validation on all POST requests. `HERMES_WEBUI_ALLOWED_ORIGINS` env var for public deployments. Proper port comparison with scheme-aware defaults.

**Our current approach:** None needed — IPC between main and renderer is local.

**Recommendation:** Not applicable to our Electron architecture. Skip.

---

### A5. Security Headers ✅ ADOPT

**What they do:** Comprehensive security headers on every response:
```python
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; ...
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), ...
```

**Our current approach:** We have CSP via HTTP headers + redundant `<meta>` tag (to be removed per IMPROVEMENTS.md #2.3). But we don't set the other headers.

**Recommendation:** Add `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer` to our Electron session headers. Quick win.

**Effort:** Trivial.

---

### A6. File Path Validation (safe_resolve) ✅ ADOPT

**What they do:** Every file operation uses `safe_resolve(root, path)` which resolves the path and verifies it stays within the root using `.relative_to()`. This prevents path traversal attacks like `../../etc/passwd`.

**Our current approach:** No file access beyond localStorage. We don't serve files.

**Recommendation:** Not applicable now. If we add a workspace file browser feature (which they have — see B5), we'd need this pattern.

---

### A7. Structured Error Handling ✅ ADOPT

**What they do:** Every route handler is wrapped in try/except with structured JSON error responses. The main process has global `uncaughtException` handling.

**Our current approach:** Per IMPROVEMENTS.md #2.2, we have no global error boundaries. This is a known critical fix.

**Recommendation:** Already in our backlog. Reaffirmed by this review.

---

### A8. Inflight State Persistence ✅ ADOPT

**What they do:** Before sending a message, they save the full state to `sessionStorage`:
```js
saveInflightState(activeSid, {streamId, messages, uploaded, toolCalls})
```
If the browser tab crashes or refreshes mid-stream, `loadInflightState()` restores progress on reload. They also detect "stream still active on the backend" via `active_stream_id` in session metadata and auto-reattach.

**Our current approach:** If Electron refreshes or crashes during streaming, the user loses the in-progress response.

**Recommendation:** Save inflight state to localStorage before each streaming request. On app restart, check for orphaned inflight states and attempt to recover (show partial response + "connection interrupted" message).

**Effort:** Medium.

---

### A9. Gateway Session Watcher (Real-time Sync) ⚠️ PARTIAL ADOPT

**What they do:** Background thread polls `state.db` every 5s for changes to gateway sessions (Telegram, Discord, etc.). When changes are detected, it pushes SSE events to all connected clients. This means the WebUI sidebar updates in real-time when you chat from Telegram.

**Our current approach:** None. Our app only shows its own sessions.

**Recommendation:** We can't poll `state.db` directly (we're a client, not the agent host). But we COULD add a health/status check endpoint to our Electron main process that periodically pings the Hermes API and shows connection status. For cross-platform session visibility, we'd need an API endpoint from Hermes gateway (see §7.4 in IMPROVEMENTS.md).

**Effort:** Low (connection status) / Blocked (cross-session visibility, needs API change).

---

### A10. Upload Size Limits & Multipart Parser ✅ ADOPT (adapted)

**What they do:** Custom multipart parser (20MB limit) that handles binary files correctly, sanitizes filenames, writes to workspace. Proper `Content-Length` validation before reading body.

**Our current approach:** We send file content as base64 in message XML. No upload endpoint or size limits.

**Recommendation:** Add a configurable max attachment size in settings. Validate file size before encoding to base64. Show upload progress for large files.

**Effort:** Low.

---

## B) Functionalities

### B1. Tool Call Visualization ✅ ADOPT (when API supports it)

**What they do:** Rich inline tool cards during streaming:
- Live progress indicator while tool is executing
- Tool name + preview text (e.g., "Searching files..." → "3 results found")
- Expandable transcript showing full input/output
- Color-coded by status (running → complete/error)
- Multi-tool support: each tool call gets its own card

**Our current approach:** Tools are invisible — the agent executes them server-side and we only see the final text response.

**Why we can't fully adopt this:** Hermes API doesn't stream tool events to us. But when (if) it does, this is the pattern to implement.

**Partial adoption now:** We can detect tool-call-like patterns in the assistant's text response (e.g., "I'll search for...") and show a minimal "Agent is working..." indicator. Not a tool card, but a step up from a blank chat.

**Effort:** Low (indicator) / Medium (full cards, needs API support).

---

### B2. Approval Flow (Human-in-the-Loop) ✅ ADOPT

**What they do:** When the agent requests approval for a dangerous command, a card appears in the chat:
- Shows command, description, risk level
- User can approve Once, For Session, or Always
- "Always" writes to a permanent allowlist
- Polled every 1.5s during streaming as a fallback, but also pushed immediately via the SSE stream

**Our current approach:** Not supported. Hermes agent has an approval system, but our client doesn't surface it.

**Recommendation:** Implement approval cards. The Hermes API supports `HERMES_EXEC_ASK` and the agent's approval module. We can poll a pending-approvals endpoint or (better) listen for approval events in the stream. This is a major UX gap — without it, the agent hangs silently when asking permission.

**Effort:** Medium-High (needs API endpoint or event detection in stream).

---

### B3. Clarify Flow (Agent Asks Questions) ✅ ADOPT

**What they do:** Mirrors the approval flow but for the `clarify` tool — when the agent needs user input before proceeding, a card appears with the question and optional choices.

**Recommendation:** Same as B2. Important for interactive workflows.

**Effort:** Medium (same infrastructure as B2).

---

### B4. Workspace File Browser ✅ ADOPT (adapted)

**What they do:** Right panel shows the session's workspace directory with:
- File tree with icons (directories first, case-insensitive sort)
- Inline file preview (markdown, code with syntax highlighting, images)
- File operations: create file/folder, delete, rename
- Safe path resolution (prevents traversal)
- 200KB file size limit for previews

**Our current approach:** None.

**Recommendation:** Add a collapsible right panel that shows the workspace directory. For our Electron app, this would access the local filesystem (the user's project directory). We'd need:
1. A `selectDirectory` dialog in main.js (Electron `dialog.showOpenDialog`)
2. IPC bridge for `listDir`, `readFile`, `writeFile`
3. Client-side tree renderer + file preview

This is a significant UX differentiator — users can see what the agent is working on.

**Effort:** High.

---

### B5. Dynamic Model Discovery ⚠️ NOT APPLICABLE

**What they do:** Fetches models from the active provider via `/api/models` and `/api/models/live`. Supports OpenAI, Anthropic, Google, OpenRouter, Ollama, and more. Smart fuzzy matching (`_findModelInDropdown`) that normalizes model IDs across provider formats.

**Our current approach:** Single model (`hermes-agent`). No picker.

**Recommendation:** Skip. As established in IMPROVEMENTS.md #4.4, we display model info, not a picker. However, their fuzzy-matching logic is worth studying if Hermes ever supports model switching.

---

### B6. Session Search & Filtering ✅ ADOPT

**What they do:** Real-time search filter on session titles. Debounced input with instant results.

**Our current approach:** No search. We have a flat session list.

**Recommendation:** Add a search input above the session list. Filter sessions by title substring match. Simple, high value.

**Effort:** Low.

---

### B7. Session Projects/Tags ✅ ADOPT (adapted)

**What they do:** Sessions can be grouped into projects with name + color. Sidebar sections by project, with untagged sessions in "All conversations".

**Our current approach:** Flat list.

**Recommendation:** Start simpler — add chat list time sections ("Today", "Yesterday", "Previous 7 Days", "Older") per IMPROVEMENTS.md #4.2. Full project/tags is a future enhancement.

**Effort:** Low (time sections) / Medium (projects).

---

### B8. Session Pin/Archive ✅ ADOPT

**What they do:** Pin important sessions to the top. Archive sessions to hide them from the main list (with an "Archived" section to recover). Duplicate sessions.

**Recommendation:** Pinning is low-effort and high value. Archive is medium effort. Both are good UX additions.

**Effort:** Low (pin) / Medium (archive).

---

### B9. Session Import/Export ✅ ADOPT

**What they do:** Export sessions as JSON (full conversation data). Import from JSON. Download as Markdown transcript.

**Recommendation:** Add "Export as Markdown" and "Export as JSON" buttons to chat settings. Import from JSON. Our localStorage-based storage makes this straightforward.

**Effort:** Medium.

---

### B10. Multi-Profile Support ⚠️ PARTIAL ADOPT

**What they do:** Multiple agent profiles (each with its own `HERMES_HOME`, config, and model). Switch between profiles in the sidebar. Each profile has its own sessions, memory, and skills.

**Our current approach:** Single profile, single Hermes endpoint.

**Recommendation:** Not needed for our single-purpose client. Our use case is connecting to one Hermes instance. Skip unless we have a multi-user scenario.

---

### B11. Clarify/Questions During Streaming ✅ ADOPT (with B2)

**What they do:** Clarify cards appear during streaming when the agent needs user input. Same UX pattern as approval cards but with free-text input.

**Recommendation:** See B2 and B3. Implement alongside approval flow.

---

### B12. Slash Commands ✅ ADOPT

**What they do:** `/reasoning on/off`, `/compact`, `/clear`, `/help`, etc. Command palette with autocomplete dropdown.

**Our current approach:** None.

**Recommendation:** Implement local slash commands: `/clear` (clear chat), `/compact` (summarize context), `/export` (export transcript), `/help`. These are client-side only and don't need API changes. Autocomplete dropdown triggered by `/`.

**Effort:** Low-Medium.

---

### B13. Voice Input ✅ ADOPT (adapted)

**What they do:** Web Speech API for real-time voice-to-text, falling back to MediaRecorder + server-side transcription via Hermes agent's `transcribe` endpoint.

**Our current approach:** None.

**Recommendation:** For our Electron app, use Web Speech API directly (available in Chromium). No server-side transcription needed for the basic case. If we want offline/privacy, we could integrate with a local Whisper model later.

**Effort:** Low (Web Speech API) / High (offline Whisper).

---

### B14. Message Edit & Regenerate ✅ ADOPT (adapted)

**What they do:** Click to edit a previous user message. Resend with modifications.

**Our current approach:** None.

**Recommendation:** For Hermes' stateful sessions, editing a past message means creating a new session (fork). We can implement "Edit & Resend" as: copy the message text to the input box, let user modify, send as new message. The old messages stay as context. True "edit and replay from this point" would require session forking, which the API may not support.

**Effort:** Low (edit-as-new-message) / High (true fork).

---

### B15. Image Paste & Upload ✅ ADOPT

**What they do:** Paste images from clipboard, drag-and-drop files. Files sent to workspace and referenced in the message.

**Our current approach:** We attach files as base64 in XML tags.

**Recommendation:** Add paste handler for images. Support drag-and-drop. Show a file tray/preview before sending.

**Effort:** Medium.

---

## C) UX

### C1. Streaming-Optimized Markdown (streamdown/smd) ✅ ADOPT

**What they do:** Use `streaming-markdown` (smd) library — an incremental DOM-building parser designed for live streams. Only re-renders the delta, handles incomplete code fences gracefully (` ``` ` without closing ` ``` `), and prevents flicker.

**Our current approach:** `marked.parse()` re-renders the entire message on every chunk. Flicker on code blocks, broken markdown during streaming.

**Recommendation:** THIS IS THE SINGLE HIGHEST-IMPACT UX IMPROVEMENT. Replace `marked` with `streaming-markdown` or implement delta rendering. The smd library is designed exactly for our use case.

**Effort:** Low-Medium (smd is a drop-in) / Medium (custom delta renderer).

---

### C2. Three-Panel Layout ⚠️ EVALUATE

**What they do:** Left sidebar (sessions) + center (chat) + right panel (workspace). All resizable via drag handles. Panels persist open/closed state in localStorage.

**Our current approach:** Two-column layout (sidebar + chat).

**Recommendation:** Reserve a right panel slot for the file browser (B4) and/or tool output. Make it collapsible and resizable. But don't add it until we have content for it. Empty panels hurt UX.

**Effort:** High (when we have content for it).

---

### C3. Syntax Highlighting (Prism.js) ✅ ADOPT

**What they do:** Prism.js with auto-loader for language detection. Streaming-aware: code blocks appear correctly during streaming. SRI hashes for CDN links.

**Our current approach:** None. Plain `<pre><code>`.

**Recommendation:** Already in IMPROVEMENTS.md #4.1. Use highlight.js or Prism.js with language label + copy button. The SRI approach is a good security practice for CDN links.

**Effort:** Low.

---

### C4. KaTeX / Math Rendering ✅ ADOPT

**What they do:** `remark-math` + `rehype-katex` + KaTeX CSS bundled. Renders `$...$` and `$$...$$` inline/block math.

**Our current approach:** None. Raw LaTeX appears as text.

**Recommendation:** Already in IMPROVEMENTS.md #4.3. Add KaTeX for math rendering.

**Effort:** Low.

---

### C5. Mermaid Diagram Rendering ✅ EVALUATE

**What they do:** Mermaid.js for flowcharts, sequence diagrams, etc. Loaded async from CDN with SRI.

**Recommendation:** Nice-to-have. Add if our agent frequently generates diagrams. Low priority.

**Effort:** Low (CDN include) / Medium (local bundle).

---

### C6. Dark/Light/System Theme + Accent Skins ✅ ADOPT

**What they do:** 3 theme modes (dark/light/system) + 7 accent color skins (Default/Gold, Ares/Red, Mono/Gray, Slate, Poseidon/Blue, Sisyphus/Purple, Charizard/Orange). Uses CSS custom properties (`--accent`, `--bg`, etc.) with `data-skin` attribute. Font size options (small/default/large). Theme preference persisted in localStorage, preloaded in `<head>` to prevent flash of wrong theme.

**Our current approach:** Basic dark theme only. No accent skin system.

**Recommendation:** High value, moderate effort. Implement CSS custom property system for theming. Start with dark/light toggle (detect OS preference via `matchMedia`). Add 3-4 accent skins (gold/default, blue, purple, gray/mono). The theme preload pattern from their `<head>` script is essential to prevent flash-of-wrong-theme.

**Effort:** Medium.

---

### C7. Resizable Panels via Drag ✅ ADOPT (with C2)

**What they do:** Drag handles on sidebar and right panel. Widths persisted in localStorage.

**Recommendation:** Implement when we add the right panel (C2). Skip for now.

---

### C8. Session Unread Indicators ✅ ADOPT

**What they do:** Badge on sessions with new messages since last view. `SESSION_VIEWED_COUNTS_KEY` in localStorage tracks how many messages each session had when last viewed.

**Recommendation:** Simple and useful. Add a dot/badge on sessions with new messages since the user last viewed them.

**Effort:** Low.

---

### C9. Message Reactions / Feedback ✅ EVALUATE

**What they do:** Thumbs up/down on assistant messages. Stored per-message.

**Recommendation:** Skip for now. Would need backend support to persist ratings.

---

### C10. Auto-Scroll Management ✅ ADOPT

**What they do:** Smart scroll — auto-scrolls to bottom during streaming, but stops if the user manually scrolls up. When user scrolls back down, auto-scroll resumes.

**Our current approach:** Always auto-scroll, which is annoying when reading a long response.

**Recommendation:** Implement "scroll anchoring" — detect if user is at the bottom before streaming chunk arrives. If yes, scroll to new content. If no, don't auto-scroll and show a "Scroll to bottom" button.

**Effort:** Low.

---

### C11. Composer UX ✅ ADOPT (multiple improvements)

**What they do:**
- **Auto-resize textarea** that grows with content up to a max height
- **Send key preference** (Enter vs Ctrl+Enter) saved in settings
- **File tray** showing attached files before sending
- **Context usage ring** — circular badge showing token usage vs. context window
- **Queue system** — when busy, messages are queued and sent sequentially per session (not globally)
- **Slash command autocomplete** — dropdown with matching commands

**Our current approach:** Fixed textarea, basic send, no queue, no context indicator.

**Recommendation:** Auto-resize + send key preference are quick wins. File tray is medium. Queue system is medium (we already block sends during streaming, but queue for after is better UX). Context ring is medium (needs token tracking from API).

**Effort:** Low–Medium per item.

---

### C12. Onboarding Wizard ✅ EVALUATE

**What they do:** First-run wizard that checks for Hermes agent, sets up provider keys, and guides the user through initial configuration. Skippable.

**Recommendation:** Our app is simpler — just needs an endpoint URL and API key. A simple connection test dialog on first launch would be useful. Skip the full wizard.

**Effort:** Low (connection test) / Skip (full wizard).

---

### C13. i18n (Internationalization) ⚠️ NOT NOW

**What they do:** Full i18n with locale detection, translation files, and per-component string resolution.

**Recommendation:** Skip. English only for our use case. But structure our UI strings so i18n could be added later (use data attributes or a string map rather than hardcoding English text in DOM manipulation).

**Effort:** N/A.

---

### C14. PWA Support ⚠️ NOT APPLICABLE

**What they do:** Service worker, manifest.json, offline caching, install prompt.

**Recommendation:** Not applicable — we're an Electron app, which already has install/offline/native feel. Skip.

---

### C15. Mobile Responsiveness ✅ ADOPT (adapted)

**What they do:** Extensive responsive CSS — single-column on mobile, hamburger menu, bottom sheet for workspace, touch-friendly tap targets. They test on mobile browsers.

**Our current approach:** Minimal responsive CSS.

**Recommendation:** Our Electron app runs in a desktop window, but users may resize. Add basic responsive breakpoints (sidebar collapse at narrow widths, touch-friendly buttons). Don't over-invest in mobile since we're not a web app.

**Effort:** Medium.

---

### C16. Accessibility (a11y) ⚠️ EVALUATE

**What they do:** ARIA labels, keyboard navigation, focus management, screen reader support.

**Recommendation:** Low priority but add `aria-label` on interactive elements as we build. Keyboard shortcuts (Cmd+K for new chat, Escape to close panels) are already in our IMPROVEMENTS.md.

**Effort:** Low (incremental).

---

## Priority Summary

### Immediate (Quick Wins) — Low effort, high impact:

| # | Item | Effort | Impact |
|---|---|---|---|
| C1 | Streaming markdown (smd or delta rendering) | Low-Med | ★★★★★ |
| C3 | Syntax highlighting + copy button | Low | ★★★★ |
| A5 | Security headers (nosniff, deny, no-referrer) | Trivial | ★★★ |
| B6 | Session search filter | Low | ★★★ |
| C10 | Smart auto-scroll | Low | ★★★ |
| C11a | Auto-resize textarea | Low | ★★★ |
| C11b | Send key preference (Enter vs Ctrl+Enter) | Low | ★★ |
| A2 | Concurrency guard (INFLIGHT tracking) | Low | ★★★ |

### Short-Term (1-2 weeks) — Medium effort, significant impact:

| # | Item | Effort | Impact |
|---|---|---|---|
| A1 | Two-endpoint streaming (proxy pattern) | Medium | ★★★★★ |
| A8 | Inflight state persistence + crash recovery | Medium | ★★★★ |
| C6 | Dark/Light/System theme + accent skins | Medium | ★★★★ |
| C4 | KaTeX math rendering | Low | ★★★ |
| C11c | File tray for attachments | Medium | ★★★ |
| C8 | Unread message indicators | Low | ★★ |
| B8 | Pin/archive sessions | Low-Med | ★★★ |

### Medium-Term (1-2 months) — Higher effort, transformative features:

| # | Item | Effort | Impact |
|---|---|---|---|
| B2 | Approval flow (human-in-the-loop) | Medium-High | ★★★★★ |
| B3 | Clarify flow (agent questions) | Medium | ★★★★ |
| B4 | Workspace file browser | High | ★★★★ |
| B12 | Slash commands + autocomplete | Low-Med | ★★★ |
| B9 | Session import/export (JSON + Markdown) | Medium | ★★★ |
| B15 | Image paste + drag-and-drop upload | Medium | ★★★ |

### Not Applicable / Deferred:

| # | Item | Reason |
|---|---|---|
| A3 | Password auth | Local Electron app; add if remote access needed |
| A4 | CSRF protection | IPC is local; not applicable |
| A6 | safe_resolve | No file serving |
| A9 | Gateway watcher | Not client-side; needs API change |
| A10 | Upload limits | Adapt later with file tray |
| B5 | Model picker | Single model; see IMPROVEMENTS.md #4.4 |
| B10 | Multi-profile | Single endpoint use case |
| B14 | Message edit | Needs session forking; implement as "copy to input" first |
| C2 | Three-panel layout | Add when we have content for right panel |
| C5 | Mermaid diagrams | Nice-to-have, low priority |
| C9 | Message feedback | Needs backend |
| C12 | Onboarding wizard | Overkill for our use case |
| C13 | i18n | English only |
| C14 | PWA | Not applicable (Electron) |

---

*End of review. Next step: discuss priorities and batch into implementation sprints.*