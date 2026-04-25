# Ollama x Hermes — Internal Context (for Cranqui)

## What it is
Desktop chat client for Hermes Agent, built with Electron. Dark-themed, streaming SSE, persistent chat history, markdown rendering.

## Location
`/Users/deibis/Documents/Claude/Projects/Ollama x Hermes/`

## Architecture

```
main.js       → Electron main process (window, CSP, IPC chat-stream/chat-cancel)
preload.js    → contextBridge: exposes window.hermesAPI {sendMessage, cancelStream, onChunk, onDone, onError, onSession, removeAllListeners}
renderer.js   → UI logic: chat CRUD, streaming, markdown, file attachments, settings, persistence (localStorage)
index.html    → Single-page layout: sidebar + main (topbar, messages, input area, settings overlay)
```

## Key Files & Responsibilities

### main.js (~230 lines)
- Creates BrowserWindow (1100×780, hiddenInset titleBar, sandbox:true, contextIsolation:true, nodeIntegration:false)
- Injects strict CSP via `onHeadersReceived` — connect-src limited to localhost:8642
- IPC handler `chat-stream`: POSTs to Hermes `/v1/chat/completions` with `stream:true`, SSE parsing, sends chunks via `chat-stream-chunk/done/error/session` events
- Also forwards `chat-stream-usage` (prompt/completion tokens from final SSE chunk) and `chat-stream-model` (real model name)
- IPC handler `get-model-info`: reads `~/.hermes/config.yaml` for real model name, calls Ollama `localhost:11434/api/show` for context window size
- Tracks `activeRequest` — cancels on chat switch or `chat-cancel` IPC
- Auth: Bearer token if apiKey configured
- Session continuity: `X-Hermes-Session-Id` header

### preload.js (~23 lines)
- Exposes `window.hermesAPI` with: sendMessage, cancelStream, onChunk/onDone/onError/onSession/onModel/onUsage callbacks, getModelInfo() async IPC call, removeAllListeners()

### renderer.js (~580 lines)
- **State**: settings (endpoint/apiKey/model), chats[] (id, title, messages[], sessionId), activeChatId, isStreaming, attachedFiles[], realModel, contextWindow, contextUsed
- **Defaults**: endpoint=`http://localhost:8642/v1/chat/completions`, apiKey=`change-me-local-dev`, model=`hermes-agent`
- **Markdown**: marked v12 (via marked.use, breaks:true, gfm:true) + DOMPurify sanitization. Fallback `_simpleMarkdown` if marked/DOMPurify fail to load.
- **Persistence**: localStorage keys `hermes_settings`, `hermes_chats`
- **Status bar** at bottom: model name (real, from config), context usage (tokens + progress bar, color-coded), session turns
- **fetchModelInfo()** at boot: IPC call reads Hermes config for real model name, Ollama for context window size
- **onUsage** listener updates context usage from SSE final chunk
- **Streaming flow**: sendMessage → appendMessageBubble(streaming) → onChunk accumulates+re-renders markdown → onDone finalizes+persists → onError shows toast
- **Settings panel**: bottom slide-over overlay, test connection hits /health then /v1/models with auth
- **Model pill**: displays current model name in input toolbar, click opens settings

### index.html (602 lines)
- CSS variables for dark theme (--bg-main:#1a1a1a, accent:#2f6de1)
- Inline `<style>` block (~460 lines), no external CSS
- Loads marked + DOMPurify from node_modules via `<script>` tags
- Layout: sidebar (240px) + main (topbar + messages + input-area)
- Welcome screen shown when no active chat
- Input area: textarea + toolbar (attach-btn, globe-btn disabled "coming soon", model-pill, send-btn)
- Settings: overlay with endpoint/apiKey/model inputs, connection test, save/cancel
- Error toast at bottom

## Dependencies
- `electron` ^41.0.0 (devDep)
- `marked` ^12.0.0 — markdown parser
- `dompurify` ^3.2.0 — HTML sanitizer

## API Contract
- Endpoint: `http://localhost:8642/v1/chat/completions` (OpenAI-compatible)
- Request: `{ model, messages, stream: true }` + Bearer auth + X-Hermes-Session-Id
- Response: SSE `data: {choices:[{delta:{content}}]}` + `data: [DONE]`
- Health: GET `/health`, Models: GET `/v1/models`

## Security
- CSP: strict, connect-src only localhost:8642
- Sandbox + contextIsolation + no nodeIntegration
- DOMPurify on all assistant output
- Bearer auth optional

## Known / TODO (from code)
- Globe button (web context) — disabled, "coming soon"
- No Ollama-specific code yet despite project name "Ollama x Hermes"
- No Electron builder configured (README suggests `electron-builder --mac`)
- Status bar shows real model (from ~/.hermes/config.yaml via IPC), context usage (tokens from SSE usage + context window from Ollama /api/show), session turns
- If Ollama not reachable, context window is null — bar shows token count only

## Run
```bash
cd "/Users/deibis/Documents/Claude/Projects/Ollama x Hermes"
npm install   # already done (node_modules present)
npm start     # electron .
```