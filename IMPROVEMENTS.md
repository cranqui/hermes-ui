# Ollama x Hermes — Improvement Backlog

> **Source:** Comparative analysis of [ollama/ollama](https://github.com/ollama/ollama) (main branch, April 2026) vs. our current Electron + vanilla JS app.
> **Date:** 2026-04-25
> **Status:** Pre-implementation — no changes applied yet.
> **Purpose:** Decision document for implementation planning. Review before any code changes.
> **Key constraint:** All improvements must respect Hermes' **stateful session architecture** — the server owns conversation context via `X-Hermes-Session-Id`. Our client is a view layer, not the source of truth.

---

## 0. Architectural Constraint: Stateful Sessions

This is the single most important difference vs. Ollama and shapes every recommendation.

| Concern | Ollama (Stateless) | Hermes (Stateful) |
|---|---|---|
| Who owns conversation history? | Client sends full `messages[]` every request | Server owns it — referenced by `sessionId` |
| What happens on reconnect? | Client replays full history | Server still has the session (if not expired) |
| Model switching mid-chat? | Free — just change `model` param | Breaks session — new model = new session |
| Message retry? | Idempotent — resend same payload | Risk of duplicate — server may have processed it |
| Client storage role | Canonical source of truth | **Optimistic UI cache** for offline display |

**Implication:** Our client stores messages for display only. The server is the authority. Every improvement must treat local state as a cache, not a ledger.

---

## 1. Context & Architecture Comparison

### Our App (Ollama x Hermes)

| Layer | Tech |
|---|---|
| Shell | Electron 41 (Node.js + Chromium) |
| Main process | `main.js` — vanilla Node, IPC bridge, HTTP streaming to Hermes API |
| Renderer | `preload.js` (contextBridge) → `renderer.js` (vanilla DOM manipulation) |
| UI | `index.html` — hand-written CSS, no framework |
| Storage | `localStorage` — single JSON blob per key (optimistic cache) |
| Security | CSP via HTTP headers + redundant `<meta>` tag, DOMPurify, `sandbox: true`, `contextIsolation: true` |
| Markdown | `marked` v12 + DOMPurify sanitization |
| Streaming | 7 separate IPC channels (`chat-stream-chunk`, `-done`, `-error`, `-usage`, `-model`, `-session`, `chat-cancel`) |
| Persistence | `hermes_settings` + `hermes_chats` in localStorage |
| Model info | IPC `get-model-info` → reads `~/.hermes/config.yaml` + Ollama `/api/show` |
| Session | `X-Hermes-Session-Id` header — server-side context continuity |

### Ollama App (Reference — for inspiration, not copy)

| Layer | Tech |
|---|---|
| Shell | Native macOS webview (Objective-C) / WebView2 on Windows |
| Backend | Go — `app/server/` manages Ollama process lifecycle, health checks, restarts |
| Frontend | React 19 + TypeScript + Vite + TanStack Router + TanStack Query + Tailwind 4 |
| Markdown | `streamdown` (streaming-optimized) + `remark-math` + `rehype-katex` + `rehype-prism-plus` + Shiki syntax highlighting |
| Storage | SQLite (WAL mode, v16 schema with migration system), accessed via Go backend APIs |
| Streaming | Single SSE stream per chat with typed `ChatEvent` (discriminated `eventName` field) |
| State | React Query cache + `StreamingContext` (tracks active stream IDs globally) |
| Types | Auto-generated TypeScript from Go structs (`typescriptify-golang-structs`) |
| UI | `framer-motion` animations, Headless UI, Heroicons |
| Updates | Platform-native updaters (Sparkle on macOS) |

### What NOT to copy from Ollama

| Ollama Pattern | Why it doesn't fit Hermes |
|---|---|
| Model picker with model list | Hermes API exposes one model: `hermes-agent`. No list to pick from. |
| Per-message `tool_calls[]` field | Hermes executes tools server-side within the session loop. The stream only surfaces final assistant content. We never see intermediate tool calls. |
| Per-message `thinking` field | Same — unless Hermes API explicitly streams a `"thinking"` event type, we can't capture what we never receive. |
| Model capabilities endpoint | Hermes capabilities are agent-dependent (tools, browsing, cron), not model-dependent. No `/v1/capabilities` exists. |
| Mid-conversation model switching | Would break the active session. New model = new session — already handled by per-chat `sessionId`. |
| Message retry queue | Re-sending a request to a stateful server risks duplicate processing if the first request partially succeeded. |
| Chat `BrowserState` in server DB | Our server doesn't store UI state. Keep scroll position, sidebar state in client-side preferences. |

---

## 2. Critical Bugs (Fix Before Anything Else)

### 2.1 Double-Response Bug

**Symptom:** The agent sometimes produces duplicate final messages.

**Root cause:** Two separate code paths in `main.js` both emit `chat-stream-done`:

1. **Line 125:** When SSE stream sends `data: [DONE]` → `event.sender.send('chat-stream-done')`
2. **Line 146:** When the HTTP response `res.on('end')` fires → `event.sender.send('chat-stream-done')`

These fire in rapid succession for every normal request. The renderer's `onDone` callback runs twice, pushing the assistant message into `chat.messages` twice and calling `saveState()` twice.

**Additional factor:** In `renderer.js`, `removeAllListeners()` (called via `window.hermesAPI.removeAllListeners()`) removes the `ipcRenderer` listeners, but new ones are registered immediately in the same `sendMessage()` call. There is no guarantee the old callbacks are fully garbage-collected before new ones fire, especially on rapid chat switching.

**Ollama's approach:** Single SSE stream with typed events. A `"done"` event is sent exactly once. The frontend uses `StreamingContext` to track which chats are currently streaming, preventing duplicate renders.

**Proposed fix:**
- Remove the `chat-stream-done` emission from the `data: [DONE]` handler (line 125). Let `res.on('end')` be the sole completion signal.
- In `preload.js`, replace the pattern of adding listeners on every `sendMessage()` with a single persistent listener set that's only registered once. Use a `setCallback` pattern where new calls replace the old callback rather than stacking.

**Risk:** Low. The fix is self-contained and testable with a single chat session.

---

### 2.2 App Crash / Unexpected Close

**Symptom:** App closes unexpectedly from time to time.

**Root cause (likely):** No global error boundaries anywhere:

- No `process.on('uncaughtException')` in main process
- No `window.onerror` / `window.addEventListener('unhandledrejection')` in renderer
- No `mainWindow.webContents.on('render-process-gone')` handler
- `chat-stream` HTTP request in `main.js` has **no timeout** on the main request object (only `fetchOllamaContextWindow` has a 5s timeout). If Hermes hangs indefinitely, the request never completes, and the renderer UI hangs in a streaming state.
- `removeAllListeners()` is called every `sendMessage()`, which can remove event listeners for other components if any are shared.

**Proposed fix:**
- Add `req.setTimeout(120_000)` on the `chat-stream` HTTP request in `main.js`.
- Add `process.on('uncaughtException', ...)` handler that logs the error and shows a recovery dialog (or restarts the renderer).
- Add `window.addEventListener('unhandledrejection', ...)` in `renderer.js`.
- Add `mainWindow.webContents.on('render-process-gone')` and `mainWindow.on('unresponsive')` handlers.
- Auto-recovery: if renderer crashes, reload it with `mainWindow.loadFile('index.html')` preserving localStorage state.

**Risk:** Low. Adds robustness without changing core flow.

---

### 2.3 Duplicate CSP Meta Tag

**Symptom:** Redundant CSP that was the source of the "inline scripts blocked" bug from session 1.

**Current state:** CSP is defined **both**:
1. As a `<meta>` tag in `index.html` (line 6): `<meta http-equiv="Content-Security-Policy" content="...">`
2. As an HTTP header injected by `main.js` (lines 35-54) via `session.defaultSession.webRequest.onHeadersReceived()`

The `<meta>` tag is redundant because HTTP headers take precedence and are the canonical CSP delivery mechanism for Electron. Worse, the meta tag caused the historic bug where `script-src 'self'` blocked all inline scripts before they were moved to external files.

**Proposed fix:** Remove the `<meta>` CSP tag from `index.html` (line 6). Keep only the HTTP header CSP in `main.js`.

**Risk:** None. HTTP-header CSP is already enforced. The meta tag is dead weight.

---

## 3. Architecture Improvements

### 3.1 Consolidate Streaming to Typed Events

**Current:** 7 IPC channels (`chat-stream-chunk`, `chat-stream-done`, `chat-stream-error`, `chat-stream-usage`, `chat-stream-model`, `chat-stream-session`, `chat-cancel`). Each requires separate listener setup and teardown.

**Ollama's approach:** Single SSE stream with a discriminated `eventName` field. Clean, one source of truth for stream lifecycle.

**Proposed:** Consolidate to a single `chat-event` IPC channel with typed payloads:
```js
// main.js
event.sender.send('chat-event', { type: 'chunk', content: delta })
event.sender.send('chat-event', { type: 'done' })
event.sender.send('chat-event', { type: 'error', message: err.message })
event.sender.send('chat-event', { type: 'usage', ...usage })
event.sender.send('chat-event', { type: 'model', name: model })
event.sender.send('chat-event', { type: 'session', id: sid })
```

```js
// renderer.js — single listener, no accumulation
window.hermesAPI.onEvent((event) => {
  switch (event.type) {
    case 'chunk': ...
    case 'done': ...
    case 'error': ...
    // etc.
  }
})
```

**Hermes-specific note:** The event types we can emit are limited to what the Hermes API `/v1/chat/completions` SSE stream provides. Currently: `choices[0].delta.content`, `usage`, `model`, and `data: [DONE]`. If Hermes API later adds `"thinking"` or `"tool_calls"` event types (see §7), we simply add new `type` branches — the architecture supports it without adding new IPC channels.

**Benefit:** Eliminates listener accumulation bugs. Makes adding new event types trivial. Single point of control for stream lifecycle.

**Effort:** Medium. Refactor main.js + preload.js + renderer.js event handling.

---

### 3.2 Enhanced Message Cache Model

**Current:** `messages[]` = `{ role, content }` only.

**Hermes constraint:** Our local message store is an **optimistic UI cache**, not the source of truth. The server owns conversation context. We only store messages for offline display and re-rendering when switching chats.

That said, we can still enrich the cache with metadata we **do** receive from the stream. Currently we receive these per-response and discard most of them:

| Data available | Where we get it | Currently stored? |
|---|---|---|
| `model` (e.g. `glm-5.1:cloud`) | `parsed.model` from SSE | ❌ Only in global `realModel` var |
| `usage.prompt_tokens` | `parsed.usage` from SSE | ❌ Only in global `contextUsed` var |
| `sessionId` | `X-Hermes-Session-Id` header/field | ✅ Stored per chat |
| Timestamps | Client-side on send/receive | ❌ Not stored |
| User attachments | `attachedFiles[]` on send | ❌ Not stored after send |

**Proposed message schema (cache, not source of truth):**
```js
{
  id: string,               // Client-generated unique ID
  role: 'user' | 'assistant',
  content: string,           // Full message text (cached for display)
  model: string | null,      // Model that produced this response (from SSE `model` field)
  promptTokens: number | null, // Context tokens consumed (from SSE `usage` field)
  attachments: [{            // Files attached by user
    name: string,
    type: string,            // MIME type
    sizeKb: number
  }],
  createdAt: number,         // Unix timestamp ms (client-side)
}
```

**What we intentionally do NOT include (conflicts with Hermes architecture):**
- ~~`thinking: string`~~ — Hermes doesn't stream thinking as a separate field. Would need API change.
- ~~`toolCalls: []`~~ — Hermes executes tools server-side. We never see them.
- ~~`toolResult`~~ — Same reason.
- ~~`system` or `tool` roles~~ — Hermes manages these server-side.

**Extension path:** If Hermes API evolves to surface tool events or thinking blocks (see §7), we add fields without schema breakage.

**Benefit:** Per-message model display, token tracking per exchange, attachment persistence, proper timestamps.

**Effort:** Medium.

---

### 3.3 Session-Aware Storage

**Current:** `localStorage` with `hermes_settings` and `hermes_chats` as JSON blobs. No indexing, no migration path.

**Hermes constraint:** Since the server is the source of truth, our storage serves two purposes:
1. **Session continuity** — `sessionId` per chat for resuming conversations
2. **Display cache** — messages for rendering when offline or between requests

**Option A: Structured localStorage (low effort)**
Keep localStorage but restructure. Replace the two giant JSON blobs with per-chat keys:
```
hermes_settings        → { endpoint, apiKey, model }
hermes_chat:{id}       → { id, title, sessionId, model, createdAt, messages: [] }
hermes_sessions        → { chatId: sessionId }  // Index for session lookup
```
This gives us O(1) chat access, avoids serializing/deserializing all chats on every save, and keeps the migration path simple.

**Option B: SQLite via better-sqlite3 (medium effort)**
If chat volume grows, move to SQLite with WAL mode. Schema:
```sql
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  model TEXT,
  prompt_tokens INTEGER,
  attachments TEXT,  -- JSON array [{name, type, sizeKb}]
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_chat_id ON messages(chat_id);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL DEFAULT 'http://localhost:8642/v1/chat/completions',
  api_key TEXT NOT NULL DEFAULT 'change-me-local-dev',
  model TEXT NOT NULL DEFAULT 'hermes-agent',
  schema_version INTEGER NOT NULL DEFAULT 1
);
```

**Session-aware migration:** Both options must preserve `sessionId` per chat. On app restart, we can attempt to resume a session by sending the first message with the stored `sessionId`. If the server has expired it, we start a new session transparently — no data loss since our cache is just a display layer.

**Recommendation:** Start with Option A (structured localStorage). It solves the performance problem (no full-JSON parse on every save) with trivial effort. Migrate to Option B only when needed.

**Effort:** Low (Option A) / Medium-High (Option B).

---

### 3.4 Graceful Error Recovery (Session-Aware)

**Current:** If Hermes API is down or request fails, user sees a toast error. No retry, no reconnection, no graceful degradation.

**Hermes constraint:** We cannot blindly retry a failed message. Since Hermes uses stateful sessions, a request that partially succeeded (server processed it, client lost the stream) would cause duplicate context if re-sent. Classic at-least-once vs. at-most-once — we should default to at-most-once (show error, let user decide to retry).

**Proposed:**
- Health check on app launch (`GET /health`) — show connection status indicator (green/red dot in sidebar footer).
- If streaming fails mid-request, show the partial response + error. Offer "Resend" button — but warn that it may create a new context entry since we can't know if the server processed the original request.
- If session is expired (server returns new `sessionId`), auto-adopt the new session silently.
- On reconnect after offline period, attempt to resume last session. If server has expired it, start fresh chat.
- Do NOT queue unsent messages for automatic retry. Manual user decision only.

**Effort:** Medium.

---

## 4. UX Improvements

### 4.1 Syntax-Highlighted Code Blocks + Copy Button

**Current:** Plain `<pre><code>` with monospace font. No language label, no copy button, no syntax highlighting.

**Ollama's approach:** Shiki with dual light/dark themes (`one-light`/`one-dark`), language label, copy button.

**Proposed (quick win):** Add `highlight.js` (lighter than Shiki, works with `marked` renderer):
```js
// In renderer.js, replace marked renderer for code blocks
marked.use({
  renderer: {
    code({ text, lang }) {
      const highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : escapeHtml(text)
      return `<div class="code-block">
        <div class="code-header"><span>${lang || ''}</span><button onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">Copy</button></div>
        <pre><code class="hljs">${highlighted}</code></pre>
      </div>`
    }
  }
})
```

**Or (streaming-optimized):** Use `streamdown` — designed for rendering incomplete markdown during streaming without flicker.

**Hermes compatibility:** No conflict. This is purely a renderer-side improvement.

**Effort:** Low (highlight.js) to Medium (streamdown).

---

### 4.2 Chat List with Time Sections

**Current:** Flat list of chats, sorted by creation order.

**Ollama's approach:** Sidebar groups chats into "Today", "Yesterday", "Previous 7 Days", "Older" sections.

**Proposed:** Add section headers based on `createdAt` timestamp in `renderSidebar()`:
```js
function groupChatsByTime(chats) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today - 86400000)
  const week = new Date(today - 7 * 86400000)
  // Group: Today, Yesterday, Previous 7 Days, Older
}
```

**Hermes compatibility:** No conflict. Uses client-side timestamps only.

**Effort:** Low.

---

### 4.3 LaTeX / Math Rendering

**Current:** No math support. LaTeX expressions render as raw text.

**Ollama's approach:** `remark-math` + `rehype-katex` + `micromark-extension-llm-math`.

**Proposed:** Add `KaTeX` (lighter than MathJax, works with vanilla JS):
```js
// In marked renderer, detect $...$ and $$...$$ blocks
// Render via katex.renderToString()
```

**Hermes compatibility:** No conflict. Pure renderer improvement.

**Effort:** Low.

---

### 4.4 Model Info Display (Not a Picker)

**Current:** Model pill shows a name, auto-discovered from the SSE stream. Clicking it opens settings.

**Ollama's approach:** Full model picker with list, capabilities, VRAM-based defaults.

**Why a picker doesn't fit us:** Hermes API exposes one model (`hermes-agent`). The real model name is whatever the underlying provider returns (e.g. `glm-5.1:cloud`). There's nothing to pick from — the model is configured in `~/.hermes/config.yaml`, not in our app.

**Proposed:** Enhance the existing model pill as an **info display**, not a picker:
- Show real model name (already working via `chat-stream-model`)
- Show context window size (already working via `get-model-info`)
- Show connection status dot (green/red) — integrate health check from #3.4
- Click still opens settings (to change endpoint/API key) but the model field becomes read-only info

**Per-chat model memory:** Since each chat has a `sessionId` bound to the model active at creation time, store `model` on each chat. Display "via glm-5.1:cloud" on older chats if the user changed models between sessions.

**Hermes compatibility:** Fully compatible. We're displaying server-provided info, not trying to control model selection.

**Effort:** Low.

---

### 4.5 Auto-Update (Electron Shell Only)

**Current:** No update mechanism.

**Ollama's approach:** Platform-native updaters (Sparkle on macOS).

**Hermes-specific consideration:** Our app is a thin client to the Hermes agent daemon. Auto-update only applies to the Electron shell — the agent itself is managed by the Hermes gateway, not our app.

**Proposed:** Check GitHub releases API on launch. Show "Update available" notification with download link. No forced updates. Simple, non-invasive.

**Effort:** Medium.

---

### 4.6 Streaming Markdown Improvements

**Current:** `marked.parse()` re-renders the entire accumulated text on every chunk. This causes:
- Visible flicker on code blocks (opening ``` without closing ```)
- Broken markdown during streaming (tables, lists mid-formation)
- Full DOM replacement on each chunk

**Ollama's approach:** `streamdown` library — designed specifically for rendering streaming markdown. Only re-renders the delta, handles incomplete blocks gracefully.

**Proposed:** Evaluate `streamdown` or implement a lightweight "streaming-aware" renderer:
- On streaming: render only the last chunk's delta, append to DOM
- On completion: full `marked.parse()` pass for proper formatting
- Handle incomplete code fences (don't render ```` as a code block until closing ``` arrives)

**Hermes compatibility:** No conflict. Pure renderer optimization.

**Effort:** Low (streamdown integration) to Medium (custom renderer).

---

## 5. Code Quality & Developer Experience

### 5.1 Modular Refactor (Not Framework Rewrite)

**Current:** ~590 lines of `renderer.js` doing manual DOM manipulation, all in one file.

**Ollama:** 20+ React components, 12 custom hooks, TanStack Query, TanStack Router.

**Why a full React/Preact rewrite is overkill for us:** Ollama is a general-purpose model management interface (model downloads, cloud accounts, capabilities, model switching). Our app is a single-purpose agent client. The scope doesn't justify a framework.

**Proposed:** Modular refactor without a framework:
```
renderer.js         → 30 lines: boot, init, bind events
chat-manager.js     → Chat CRUD, session management
stream-handler.js   → SSE processing, chunk accumulation, event dispatch
ui-renderer.js      → DOM rendering (sidebar, messages, status bar)
markdown.js         → marked config, highlight.js, KaTeX integration
settings.js         → Settings panel logic
storage.js          → State persistence (localStorage or SQLite)
```

Use ES modules (`<script type="module">`) — already supported by Electron's Chromium. No bundler needed.

**Hermes compatibility:** No conflict. Internal refactor only.

**Effort:** Medium.

---

### 5.2 TypeScript for New Code

**Current:** Pure vanilla JS. The listener accumulation bug (#2.1) would have been caught by TypeScript.

**Ollama:** Full type safety with auto-generated types.

**Proposed:** Gradual adoption — write any **new** code in TypeScript. Don't rewrite existing files:
1. New modules from #5.1 (e.g. `stream-handler.ts`, `storage.ts`) are written in TS
2. Add `tsconfig.json` with `"allowJs": true` for gradual migration
3. Use `esbuild` or `tsc` to compile TS → JS before Electron loads
4. Type the IPC bridge with a shared `types.ts`

**Effort:** Low (per new file), High (full migration). Start incremental.

---

### 5.3 Remove Dead Code

**Known dead weight:**
- The `<meta>` CSP tag (line 6 of `index.html`) — redundant with HTTP header CSP (#2.3).
- Old `fetchModel()` function — superseded by `fetchModelInfo()`. Verify removed.
- `buildMessageWithAttachments()` — Hermes-specific XML wrapping. Document the convention, don't remove.

---

## 6. Implementation Priority Matrix

| # | Item | Impact | Effort | Dependencies | Order |
|---|---|---|---|---|---|
| 2.3 | Remove duplicate CSP `<meta>` tag | Security | Trivial | None | 🥇 First |
| 2.1 | Fix double-response bug | Critical | Low | None | 🥇 First |
| 2.2 | Error boundary + request timeouts | Critical | Low | None | 🥇 First |
| 3.1 | Consolidate streaming to typed events | High | Medium | None | 🥈 Second |
| 4.1 | Syntax highlighting + copy button | High | Low | None | 🥈 Second |
| 4.2 | Chat list time sections | Low | Trivial | None | 🥈 Second |
| 4.3 | LaTeX rendering | Low | Low | None | 🥈 Second |
| 4.6 | Streaming markdown improvements | High | Low-Medium | None | 🥈 Second |
| 3.2 | Enhanced message cache model | Medium | Medium | None | 🥉 Third |
| 4.4 | Model info display (not picker) | Low | Low | None | 🥉 Third |
| 3.3 | Structured localStorage → SQLite | Medium | Low / Med-High | None | 🥉 Third |
| 3.4 | Graceful error recovery | Medium | Medium | #2.2 | 🎯 Later |
| 5.1 | Modular refactor | Medium | Medium | None | 🎯 Later |
| 5.2 | TypeScript (new code) | Medium | Low (incremental) | None | 🎯 Later |
| 4.5 | Auto-update | Low | Medium | None | 🎯 Later |

---

## 7. Future Extension Points (Dependent on Hermes API Evolution)

These are not actionable today but become viable if the Hermes API server adds support. Included so we can design for extensibility.

### 7.1 Thinking/Reasoning UI
**If** Hermes API streams a `"thinking"` event type (separate from `delta.content`), we can:
- Show agent reasoning in a collapsible `<details>` block
- Track thinking duration
- Toggle visibility in the input toolbar

**Design for it now:** The consolidated event system (#3.1) supports adding a `{ type: 'thinking', content: '...' }` event without architectural change. The enhanced message model (#3.2) can add an optional `thinking` field when data becomes available.

### 7.2 Tool Call Visualization
**If** Hermes API surfaces tool invocations as they happen (e.g. `"tool_call"` event with name, arguments, and result), we can:
- Show a collapsible "Used 3 tools" section per assistant message
- Display tool name, input, and output
- Visualize the agent's action chain

**Design for it now:** Event system is extensible. Message model can add optional `toolCalls` field. No need to implement UI until the API supports it.

### 7.3 Model Capabilities
**If** Hermes API exposes an endpoint to query agent capabilities (tools available, browsing enabled, etc.), we can:
- Conditionally show UI elements (file upload for vision, tool toggle for agent mode)
- Display capability badges on the model pill

**Design for it now:** The model pill (#4.4) is already designed as an info display. Adding capability badges is a UI-only change.

### 7.4 Session State Query
**If** Hermes API allows querying session state (e.g. `GET /v1/sessions/{id}/status`), we can:
- Implement safe message retry (check if last request was processed before resending)
- Resume interrupted sessions cleanly
- Show session metadata (turn count, tokens used, tools invoked)

**Design for it now:** Error recovery (#3.4) assumes we CAN'T do this. Adding session queries later would upgrade "manual retry" to "informed retry" without changing the overall architecture.

---

## 8. Open Questions

- [ ] **Thinking format:** When Hermes agent "thinks," does it send `<tool_call>` tags in content, or a separate `thinking` field? Need to check `api_server.py` SSE output format.
- [ ] **Session expiry behavior:** How long does Hermes keep a session alive after last message? What HTTP status/code indicates expired session? This affects #3.4.
- [ ] **Partial success detection:** If a streaming request is interrupted (client disconnects), does Hermes continue processing or abort? This determines retry safety.
- [ ] **Structured localStorage vs SQLite:** Do we need SQLite at our expected chat volume (~10-50 chats)? Or is per-chat localStorage keys (#3.3 Option A) sufficient?

---

## 9. UX Backlog (from April 2026 audit)

These items were identified in a full app audit and are ready for implementation. They are lower priority than the critical bugs above but meaningfully improve daily usability.

### 9.1 Delete confirmation

**Problem:** Clicking the trash icon on a chat deletes it instantly with no undo. One misclick on a long conversation destroys it permanently.

**Proposed:** A two-step pattern — first click turns the icon red and shows a small "confirm?" tooltip, second click within 3 seconds confirms. No modal dialogs needed. Alternatively, `window.confirm()` as a quick fix.

**Effort:** Low.

---

### 9.2 Window size and position persistence

**Problem:** Every restart opens the window at exactly 1100×780 regardless of where you left it.

**Proposed:** Use `electron-window-state` package, or manually save `{ x, y, width, height }` to `app.getPath('userData')/window-state.json` on `close` and restore in `createWindow()`.

**Effort:** Low.

---

### 9.3 Full-text chat search

**Problem:** The sidebar search only matches chat titles. Searching for a topic discussed in a conversation requires remembering what you titled it.

**Proposed:** On each keypress in the search box, also scan `chat.messages[].content` for the query. Show a match count badge on each result. Keep title matches ranked above body matches.

**Effort:** Low-Medium (depends on chat volume; localStorage is fast enough for <200 chats).

---

### 9.4 Keyboard shortcuts

**Problem:** No hotkeys for common actions.

**Proposed shortcuts:**

| Shortcut | Action |
|---|---|
| `Cmd+N` | New chat |
| `Cmd+K` | Focus sidebar search |
| `Cmd+,` | Open settings |
| `Escape` | Cancel stream / close settings |
| `Cmd+Shift+T` | Toggle Activity sidebar (already works) |

Wire these in `renderer.js` via a `document.addEventListener('keydown', ...)` handler. Already have a model for this from the Activity sidebar shortcut.

**Effort:** Low.

---

### 9.5 AI-generated chat titles

**Problem:** Chat titles are the first user message truncated to 80 chars — often not meaningful ("Hey can you help me with…").

**Proposed:** After the first assistant reply completes, send a silent background request to the Hermes API with a system prompt like `"Summarize this conversation in 5 words or fewer"`. Set the result as the chat title. Show a short animation on the title while it generates.

**Hermes note:** This would create a second session or require a special `X-Hermes-No-Session` header to avoid polluting the chat context. Verify API supports it.

**Effort:** Medium.

---

### 9.6 Activity sidebar auto-clears on new message

**Problem:** If message A triggered tools and opened the sidebar, message B (with no tools) leaves the sidebar open showing stale activity from A.

**Proposed:** `clearToolList()` is already called in `newChat()` and `switchChat()`. Also call it at the start of each `sendMessage()` before the stream begins, so the Activity panel resets for every new outgoing message.

**Effort:** Trivial (one line).

---

### 9.7 Per-chat scroll position memory

**Problem:** Switching away from a chat and back always jumps to the bottom. Reading history mid-conversation loses your place.

**Proposed:** Store `scrollTop` per `chatId` in a `Map<chatId, number>`. On `switchChat()`, save the current scroll position before switching. On `renderMessages()`, restore it after render (with a `requestAnimationFrame` delay to wait for layout).

**Effort:** Low.

---

### 9.8 Copy button on user messages

**Problem:** Code blocks have a copy button. User message bubbles do not, making it awkward to reuse text you typed.

**Proposed:** On hover of a `.msg-row.user`, show a small copy icon (matching the code-copy-btn style) in the top-right corner of the bubble. On click, copy `bubble.textContent` to clipboard.

**Effort:** Low.

---

*End of document. Review, discuss, then implement in batches per the priority matrix.*