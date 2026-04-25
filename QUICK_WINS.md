# Quick Wins — Hermes UI Improvements

> Source: [nesquena/hermes-webui](https://github.com/nesquena/hermes-webui) comparative review
> Date: 2026-04-25

## Implemented

| # | Improvement | Effort | Impact | Status |
|---|---|---|---|---|
| 1 | Security headers (nosniff, deny, no-referrer) | Trivial | ★★★ | ✅ |
| 2 | Concurrency guard (INFLIGHT per-session tracking) | Low | ★★★ | ✅ |
| 3 | Smart auto-scroll with "scroll to bottom" button | Low | ★★★ | ✅ |
| 4 | Auto-resize textarea (already partial, fixed edge cases) | Low | ★★★ | ✅ |
| 5 | Send key preference (Enter / Ctrl+Enter) persisted | Low | ★★ | ✅ |
| 6 | Session search filter | Low | ★★★ | ✅ |
| 7 | Syntax highlighting (highlight.js) + copy button | Low | ★★★★ | ✅ |
| 8 | Streaming markdown delta rendering (no full re-parse) | Low-Med | ★★★★★ | ✅ |

## What each change does

### 1. Security headers
Added `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` to Electron session headers. Prevents MIME sniffing, clickjacking, and referrer leaks.

### 2. Concurrency guard
Per-session `inflightChatId` tracking. If user sends while another stream is active on the *same chat*, the request is rejected with a toast. Different chats can stream independently (though main.js currently supports one active request — future enhancement).

### 3. Smart auto-scroll
Tracks whether user is near bottom (`isNearBottom()`). Only auto-scrolls during streaming if user hasn't scrolled up. Shows a "↓ Scroll to bottom" floating button when not at bottom during active stream.

### 4. Auto-resize textarea
Existing `autoResize()` was basic. Added: reset on clear, smooth height transition, respect `max-height` via CSS transition instead of hard clamp.

### 5. Send key preference
Setting: `sendKey` = `"enter"` (default) or `"ctrl-enter"`. Persisted in localStorage. When "ctrl-enter", plain Enter inserts newline. Toggle in settings panel.

### 6. Session search filter
Search input above chat list. Debounced 150ms. Filters sessions by title substring. Hidden when empty, no extra UI clutter.

### 7. Syntax highlighting + copy button
Added `highlight.js` (self-hosted, CSP-safe). Code blocks get language label + one-click copy button. Styled to match existing theme. Falls back to unhighlighted if hljs fails to load.

### 8. Streaming markdown delta rendering
Instead of `marked.parse(fullText)` on every chunk (flicker, broken code fences), we now:
- Track whether we're inside a code fence
- Only re-render the last line + re-close any open fence
- Full re-render only on stream completion
- Result: no flicker, code blocks render correctly mid-stream

---

## Next batch (short-term)

From HERMES_WEBUI_REVIEW.md priority summary:
- Two-endpoint streaming proxy (cancel + reconnect)
- Inflight state persistence + crash recovery
- Dark/Light/System theme + accent skins
- KaTeX math rendering
- Unread message indicators
- Pin/archive sessions